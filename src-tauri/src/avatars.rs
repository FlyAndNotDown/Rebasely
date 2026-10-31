//! Optional public-profile lookups. Built-in avatars never create an HTTP client.
//! https://docs.github.com/en/rest/search/search#search-users
//! https://docs.gitlab.com/api/users/

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::{Client, Response};
use serde::Deserialize;
use url::Url;

use crate::prefs::{AppPrefs, AvatarProvider};

const MAX_BODY_BYTES: usize = 65_536;
const MAX_CACHE_BYTES: usize = 8 * 1_048_576;
const MAX_CACHE_ENTRIES: usize = 256;
const POSITIVE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const NEGATIVE_TTL: Duration = Duration::from_secs(15 * 60);
static STATE: OnceLock<Mutex<AvatarState>> = OnceLock::new();

#[derive(Clone, PartialEq)]
struct Policy {
    provider: AvatarProvider,
    proxy: crate::network::HttpProxy,
}

impl From<&AppPrefs> for Policy {
    fn from(prefs: &AppPrefs) -> Self {
        Self {
            provider: prefs.avatar_provider,
            proxy: prefs.http_proxy.clone(),
        }
    }
}

struct Cached {
    data: Option<String>,
    expires: Instant,
    touched: Instant,
}

struct Active {
    id: u64,
    cancel: Option<Box<dyn FnOnce() + Send>>,
}

#[derive(Default)]
struct AvatarState {
    policy: Option<Policy>,
    generation: u64,
    sequence: u64,
    cache: HashMap<String, Cached>,
    active: HashMap<String, Active>,
    requests: VecDeque<Instant>,
    blocked_until: Option<Instant>,
}

fn state() -> &'static Mutex<AvatarState> {
    STATE.get_or_init(Mutex::default)
}

/// Call after successfully saving preferences. Cancels the old provider's work.
/// No disk access, network requests, or user data logging occurs here.
pub fn preferences_changed(prefs: &AppPrefs) {
    let Ok(mut state) = state().lock() else {
        return;
    };
    let policy = Policy::from(prefs);
    if state.policy.as_ref() == Some(&policy) {
        return;
    }
    state.policy = Some(policy);
    state.generation = state.generation.wrapping_add(1);
    state.cache.clear();
    // Keep the request budget across setting changes; toggling cannot bypass it.
    let cancelled: Vec<_> = state
        .active
        .drain()
        .filter_map(|(_, active)| active.cancel)
        .collect();
    drop(state);
    for cancel in cancelled {
        cancel();
    }
}

/// Failures are intentionally silent and fall back to the local avatar.
pub async fn lookup(prefs: AppPrefs, email: String) -> Option<String> {
    if prefs.avatar_provider == AvatarProvider::Builtin {
        return None;
    }
    let email = normalized_email(&email)?;
    let policy = Policy::from(&prefs);
    let (generation, id) = {
        let mut state = state().lock().ok()?;
        // Saved preferences are authoritative over a stale command snapshot.
        if state.policy.is_none() {
            state.policy = Some(policy.clone());
        }
        if state.policy.as_ref() != Some(&policy) {
            return None;
        }
        let now = Instant::now();
        if let Some(cached) = state
            .cache
            .get_mut(&email)
            .filter(|entry| entry.expires > now)
        {
            cached.touched = now;
            return cached.data.clone();
        }
        if state.active.len() >= 2 || state.active.contains_key(&email) {
            return None;
        }
        state.sequence = state.sequence.wrapping_add(1);
        let id = state.sequence;
        state
            .active
            .insert(email.clone(), Active { id, cancel: None });
        (state.generation, id)
    };
    let task_email = email.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _lease = ActiveLease {
            email: task_email.clone(),
            id,
        };
        let data = match crate::network::client_from_preferences(&prefs) {
            Ok(client) => fetch(&client, prefs.avatar_provider, &task_email, generation).await,
            Err(_) => None,
        };
        let mut state = state().lock().ok()?;
        if state.generation != generation {
            return None;
        }
        state.insert(task_email, data.clone(), Instant::now());
        data
    });
    let abort = task.inner().abort_handle();
    {
        let mut state = state().lock().ok()?;
        if let Some(active) = state
            .active
            .get_mut(&email)
            .filter(|active| active.id == id)
        {
            active.cancel = Some(Box::new(move || abort.abort()));
        } else {
            abort.abort();
        }
    }
    task.await.ok().flatten()
}

struct ActiveLease {
    email: String,
    id: u64,
}

impl Drop for ActiveLease {
    fn drop(&mut self) {
        if let Ok(mut state) = state().lock() {
            if state
                .active
                .get(&self.email)
                .is_some_and(|active| active.id == self.id)
            {
                state.active.remove(&self.email);
            }
        }
    }
}

impl AvatarState {
    fn insert(&mut self, key: String, data: Option<String>, now: Instant) {
        self.cache.retain(|_, entry| entry.expires > now);
        let ttl = if data.is_some() {
            POSITIVE_TTL
        } else {
            NEGATIVE_TTL
        };
        self.cache.insert(
            key,
            Cached {
                data,
                expires: now + ttl,
                touched: now,
            },
        );
        while self.cache.len() > MAX_CACHE_ENTRIES
            || self
                .cache
                .values()
                .map(|entry| entry.data.as_ref().map_or(0, String::len))
                .sum::<usize>()
                > MAX_CACHE_BYTES
        {
            let Some(oldest) = self
                .cache
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.cache.remove(&oldest);
        }
    }

    fn allow_request(&mut self, generation: u64, now: Instant) -> bool {
        while self
            .requests
            .front()
            .is_some_and(|start| now.duration_since(*start) >= Duration::from_secs(3600))
        {
            self.requests.pop_front();
        }
        if self.generation != generation
            || self.blocked_until.is_some_and(|until| until > now)
            || self.requests.len() >= 48
            || self
                .requests
                .iter()
                .filter(|start| now.duration_since(**start) < Duration::from_secs(60))
                .count()
                >= 8
        {
            return false;
        }
        self.requests.push_back(now);
        true
    }
}

async fn request(
    client: &Client,
    url: Url,
    generation: u64,
    accept: &'static str,
) -> Option<Response> {
    if !state()
        .lock()
        .ok()?
        .allow_request(generation, Instant::now())
    {
        return None;
    }
    let response = client
        .get(url)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", "2026-03-10")
        .send()
        .await
        .ok()?;
    if matches!(response.status().as_u16(), 403 | 429) {
        if let Ok(mut state) = state().lock() {
            state.blocked_until = Some(Instant::now() + NEGATIVE_TTL);
        }
    }
    if !response.status().is_success() {
        return None;
    }
    Some(response)
}

async fn bounded_body(mut response: Response) -> Option<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

async fn json<T: serde::de::DeserializeOwned>(
    client: &Client,
    url: Url,
    generation: u64,
) -> Option<T> {
    let response = request(
        client,
        url,
        generation,
        "application/vnd.github.text-match+json, application/json",
    )
    .await?;
    let body = bounded_body(response).await?;
    serde_json::from_slice(&body).ok()
}

#[derive(Deserialize)]
struct GithubUser {
    id: u64,
    login: String,
    email: Option<String>,
    #[serde(default)]
    text_matches: Vec<TextMatch>,
}

#[derive(Deserialize)]
struct TextMatch {
    property: String,
    fragment: String,
}

#[derive(Deserialize)]
struct GithubSearch {
    #[serde(default)]
    incomplete_results: bool,
    items: Vec<GithubUser>,
}

#[derive(Deserialize)]
struct GitlabUser {
    id: u64,
    username: String,
    avatar_url: Option<String>,
    public_email: Option<String>,
}

async fn fetch(
    client: &Client,
    provider: AvatarProvider,
    email: &str,
    generation: u64,
) -> Option<String> {
    let avatar = match provider {
        AvatarProvider::Builtin => return None,
        AvatarProvider::Github => {
            let user = if let Some((id, login)) = github_noreply(email) {
                let mut endpoint = Url::parse("https://api.github.com/").ok()?;
                if let Some(id) = id {
                    endpoint.set_path(&format!("user/{id}"));
                } else {
                    endpoint.path_segments_mut().ok()?.extend(["users", &login]);
                }
                let user: GithubUser = json(client, endpoint, generation).await?;
                if !user.login.eq_ignore_ascii_case(&login) || id.is_some_and(|id| user.id != id) {
                    return None;
                }
                user
            } else {
                let mut endpoint = Url::parse("https://api.github.com/search/users").ok()?;
                endpoint
                    .query_pairs_mut()
                    .append_pair("q", &format!("\"{email}\" in:email type:user"))
                    .append_pair("per_page", "3");
                let results: GithubSearch = json(client, endpoint, generation).await?;
                if results.incomplete_results || results.items.len() > 3 {
                    return None;
                }
                let mut verified = results
                    .items
                    .into_iter()
                    .filter(|user| github_email_matches(user, email));
                let user = verified.next()?;
                if verified.next().is_some() {
                    return None;
                }
                user
            };
            if user.id == 0 || !valid_login(&user.login, false) {
                return None;
            }
            // Build the CDN URL from a verified numeric ID; never trust avatar_url.
            Url::parse(&format!(
                "https://avatars.githubusercontent.com/u/{}?s=40&v=4",
                user.id
            ))
            .ok()?
        }
        AvatarProvider::Gitlab => {
            let mut endpoint = Url::parse("https://gitlab.com/api/v4/users").ok()?;
            let noreply = gitlab_noreply(email);
            if let Some((_, username)) = &noreply {
                endpoint.query_pairs_mut().append_pair("username", username);
            } else {
                endpoint
                    .query_pairs_mut()
                    .append_pair("public_email", email);
            }
            endpoint.query_pairs_mut().append_pair("per_page", "2");
            let users: Vec<GitlabUser> = json(client, endpoint, generation).await?;
            if users.len() != 1 {
                return None;
            }
            let user = users.into_iter().next()?;
            if user.id == 0 || !valid_login(&user.username, true) {
                return None;
            }
            if let Some((id, username)) = noreply {
                if user.id != id || !user.username.eq_ignore_ascii_case(&username) {
                    return None;
                }
            } else if user
                .public_email
                .as_ref()
                .is_some_and(|public| !public.eq_ignore_ascii_case(email))
            {
                return None;
            }
            gitlab_avatar_url(user.avatar_url.as_deref()?, user.id)?
        }
    };
    let response = request(
        client,
        avatar,
        generation,
        "image/png, image/jpeg, image/webp, image/gif",
    )
    .await?;
    let mime = response
        .headers()
        .get("content-type")?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase();
    let body = bounded_body(response).await?;
    if !safe_image(&body, &mime) {
        return None;
    }
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(body)
    ))
}

fn normalized_email(email: &str) -> Option<String> {
    let email = email.trim();
    if email.len() > 254 || !email.is_ascii() {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || local.len() > 64
        || domain.is_empty()
        || domain.contains('@')
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-+%".contains(&byte))
        || !domain.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(email.to_ascii_lowercase())
}

fn valid_login(login: &str, gitlab: bool) -> bool {
    let maximum = if gitlab { 255 } else { 39 };
    !login.is_empty()
        && login.len() <= maximum
        && login.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || (gitlab && matches!(byte, b'_' | b'.'))
        })
}

fn github_noreply(email: &str) -> Option<(Option<u64>, String)> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let (id, login) = if let Some((id, login)) = local.split_once('+') {
        (Some(id.parse::<u64>().ok().filter(|id| *id > 0)?), login)
    } else {
        (None, local)
    };
    valid_login(login, false).then(|| (id, login.to_string()))
}

fn gitlab_noreply(email: &str) -> Option<(u64, String)> {
    let local = email
        .strip_suffix("@users.noreply.gitlab.com")
        .or_else(|| email.strip_suffix("@noreply.gitlab.com"))?;
    let (id, login) = local.split_once('-')?;
    let id = id.parse::<u64>().ok().filter(|id| *id > 0)?;
    valid_login(login, true).then(|| (id, login.to_string()))
}

fn github_email_matches(user: &GithubUser, email: &str) -> bool {
    user.email
        .as_ref()
        .is_some_and(|public| public.eq_ignore_ascii_case(email))
        || user
            .text_matches
            .iter()
            .any(|item| item.property == "email" && item.fragment.eq_ignore_ascii_case(email))
}

fn gitlab_avatar_url(value: &str, id: u64) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(
            url.host_str(),
            Some("gitlab.com" | "assets.gitlab-static.net")
        )
    {
        return None;
    }
    let path = url.path();
    let prefix = format!("/uploads/-/system/user/avatar/{id}/");
    let legacy = format!("/uploads/user/avatar/{id}/");
    if !path.starts_with(&prefix) && !path.starts_with(&legacy) {
        return None;
    }
    let name = path.rsplit('/').next()?;
    if name.is_empty()
        || path.contains('%')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return None;
    }
    Some(url)
}

fn safe_image(bytes: &[u8], mime: &str) -> bool {
    let dimensions = match mime {
        "image/png"
            if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") =>
        {
            bytes.get(16..24).map(|size| {
                (
                    u32::from_be_bytes(size[..4].try_into().unwrap()),
                    u32::from_be_bytes(size[4..].try_into().unwrap()),
                )
            })
        }
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
            bytes.get(6..10).map(|size| {
                (
                    u32::from(u16::from_le_bytes(size[..2].try_into().unwrap())),
                    u32::from(u16::from_le_bytes(size[2..].try_into().unwrap())),
                )
            })
        }
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8]) => jpeg_dimensions(bytes),
        "image/webp" if bytes.get(..4) == Some(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            webp_dimensions(bytes)
        }
        _ => None,
    };
    dimensions
        .is_some_and(|(width, height)| width > 0 && height > 0 && width <= 512 && height <= 512)
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut index = 2;
    while index + 4 <= bytes.len() {
        if bytes[index] != 0xff {
            return None;
        }
        let marker = bytes[index + 1];
        if marker == 0xff {
            index += 1;
            continue;
        }
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            index += 2;
            continue;
        }
        let length = usize::from(u16::from_be_bytes(
            bytes[index + 2..index + 4].try_into().ok()?,
        ));
        if length < 2 || index + 2 + length > bytes.len() {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let size = bytes.get(index + 5..index + 9)?;
            return Some((
                u32::from(u16::from_be_bytes(size[2..4].try_into().ok()?)),
                u32::from(u16::from_be_bytes(size[..2].try_into().ok()?)),
            ));
        }
        index += length + 2;
    }
    None
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match bytes.get(12..16)? {
        b"VP8X" => {
            let size = bytes.get(24..30)?;
            Some((
                u32::from_le_bytes([size[0], size[1], size[2], 0]) + 1,
                u32::from_le_bytes([size[3], size[4], size[5], 0]) + 1,
            ))
        }
        b"VP8 " if bytes.get(23..26) == Some(&[0x9d, 0x01, 0x2a]) => {
            let size = bytes.get(26..30)?;
            Some((
                u32::from(u16::from_le_bytes(size[..2].try_into().ok()?) & 0x3fff),
                u32::from(u16::from_le_bytes(size[2..].try_into().ok()?) & 0x3fff),
            ))
        }
        b"VP8L" if bytes.get(20) == Some(&0x2f) => {
            let size = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
            Some(((size & 0x3fff) + 1, ((size >> 14) & 0x3fff) + 1))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_queries_cannot_inject_search_qualifiers_or_urls() {
        assert_eq!(
            normalized_email(" Alice+work@Example.com "),
            Some("alice+work@example.com".into())
        );
        for email in [
            "",
            "alice",
            "alice@example.com in:login",
            "\"a\"@example.com",
            "a@b@c",
            "a\n@example.com",
            "https://example.com",
            "a@.example.com",
        ] {
            assert!(normalized_email(email).is_none(), "{email}");
        }
    }

    #[test]
    fn noreply_addresses_bind_to_provider_ids_and_logins() {
        assert_eq!(
            github_noreply("42+alice@users.noreply.github.com"),
            Some((Some(42), "alice".into()))
        );
        assert_eq!(
            github_noreply("alice@users.noreply.github.com"),
            Some((None, "alice".into()))
        );
        assert!(github_noreply("42+alice@users.noreply.github.com.example.com").is_none());
        assert!(github_noreply("0+alice@users.noreply.github.com").is_none());
        assert_eq!(
            gitlab_noreply("42-alice-work@users.noreply.gitlab.com"),
            Some((42, "alice-work".into()))
        );
        assert_eq!(
            gitlab_noreply("42-alice@noreply.gitlab.com"),
            Some((42, "alice".into()))
        );
        assert!(gitlab_noreply("alice@users.noreply.gitlab.com").is_none());
    }

    #[test]
    fn public_email_search_needs_an_exact_email_field_match() {
        let mut user: GithubUser = serde_json::from_str(r#"{"id":42,"login":"alice","text_matches":[{"property":"name","fragment":"alice@example.com"}]}"#).unwrap();
        assert!(!github_email_matches(&user, "alice@example.com"));
        user.text_matches[0].property = "email".into();
        assert!(github_email_matches(&user, "ALICE@example.com"));
        assert!(!github_email_matches(&user, "ali@example.com"));
        user.text_matches[0].fragment = "other alice@example.com text".into();
        assert!(!github_email_matches(&user, "alice@example.com"));
    }

    #[test]
    fn avatar_urls_stay_on_the_verified_provider_and_user_path() {
        assert!(gitlab_avatar_url(
            "https://gitlab.com/uploads/-/system/user/avatar/42/avatar.png",
            42
        )
        .is_some());
        for value in [
            "http://gitlab.com/uploads/user/avatar/42/a.png",
            "https://gitlab.com:444/uploads/user/avatar/42/a.png",
            "https://127.0.0.1/uploads/user/avatar/42/a.png",
            "https://gitlab.com.evil.example/uploads/user/avatar/42/a.png",
            "https://alice@gitlab.com/uploads/user/avatar/42/a.png",
            "https://secure.gravatar.com/avatar/abc",
            "https://gitlab.com/uploads/user/avatar/43/a.png",
            "https://gitlab.com/uploads/user/avatar/42/a.svg?url=http://localhost",
            "https://gitlab.com/uploads/user/avatar/42/%2e%2e/a.png",
        ] {
            assert!(gitlab_avatar_url(value, 42).is_none(), "{value}");
        }
    }

    #[test]
    fn image_validation_rejects_svg_mismatched_types_and_oversized_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&40_u32.to_be_bytes());
        png.extend_from_slice(&40_u32.to_be_bytes());
        assert!(safe_image(&png, "image/png"));
        assert!(!safe_image(&png, "image/jpeg"));
        assert!(!safe_image(
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            "image/png"
        ));
        png[16..20].copy_from_slice(&100_000_u32.to_be_bytes());
        assert!(!safe_image(&png, "image/png"));
        assert!(!safe_image(b"GIF89a", "image/gif"));
    }

    #[test]
    fn request_rate_and_generation_guards_cannot_be_bypassed() {
        let mut state = AvatarState::default();
        let now = Instant::now();
        for _ in 0..8 {
            assert!(state.allow_request(0, now));
        }
        assert!(!state.allow_request(0, now));
        assert!(!state.allow_request(1, now + Duration::from_secs(61)));
        assert!(state.allow_request(0, now + Duration::from_secs(61)));
        state.blocked_until = Some(now + Duration::from_secs(120));
        assert!(!state.allow_request(0, now + Duration::from_secs(62)));
    }

    #[test]
    fn cache_has_entry_byte_and_negative_expiration_limits() {
        let mut state = AvatarState::default();
        let now = Instant::now();
        for index in 0..300 {
            state.insert(index.to_string(), None, now + Duration::from_millis(index));
        }
        assert_eq!(state.cache.len(), MAX_CACHE_ENTRIES);
        assert!(!state.cache.contains_key("0"));
        for index in 0..150 {
            state.insert(
                format!("image-{index}"),
                Some("x".repeat(MAX_BODY_BYTES)),
                now + Duration::from_secs(1),
            );
        }
        assert!(
            state
                .cache
                .values()
                .map(|entry| entry.data.as_ref().map_or(0, String::len))
                .sum::<usize>()
                <= MAX_CACHE_BYTES
        );
        state.insert(
            "later".into(),
            None,
            now + POSITIVE_TTL + Duration::from_secs(5),
        );
        assert_eq!(state.cache.len(), 1);
    }
}
