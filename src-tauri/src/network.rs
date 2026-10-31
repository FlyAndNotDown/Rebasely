//! HTTP routing for the client itself. Repository CLI processes keep their own configuration.

use std::time::Duration;

use reqwest::{Client, ClientBuilder, Proxy};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::prefs::AppPrefs;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    None,
    #[default]
    System,
    Manual,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpProxy {
    #[serde(default)]
    pub mode: ProxyMode,
    #[serde(default)]
    pub url: String,
}

#[derive(Clone)]
pub enum HttpPolicy {
    Direct,
    System,
    Manual(Box<Proxy>),
}

impl HttpPolicy {
    pub fn apply(&self, builder: ClientBuilder) -> ClientBuilder {
        match self {
            Self::Direct => builder.no_proxy(),
            Self::System => builder,
            Self::Manual(proxy) => builder.no_proxy().proxy(proxy.as_ref().clone()),
        }
    }
}

pub fn normalize_proxy(proxy: HttpProxy) -> AppResult<HttpProxy> {
    if proxy.mode != ProxyMode::Manual {
        return Ok(HttpProxy {
            mode: proxy.mode,
            url: String::new(),
        });
    }
    let text = proxy.url.trim();
    if text.len() > 2048 || text.chars().any(char::is_control) {
        return Err(AppError::msg("Enter a valid proxy URL."));
    }
    let url = url::Url::parse(text).map_err(|_| {
        AppError::msg("Enter a proxy URL including http://, https://, socks5://, or socks5h://.")
    })?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
        || url.host_str().is_none()
        || url.port() == Some(0)
    {
        return Err(AppError::msg(
            "Use an HTTP, HTTPS, SOCKS5, or SOCKS5H proxy URL.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::msg("Proxy URLs cannot contain credentials. Use a proxy that does not require authentication."));
    }
    if url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
        return Err(AppError::msg(
            "A proxy URL can contain only a scheme, host, and port.",
        ));
    }
    Proxy::all(url.as_str()).map_err(|_| AppError::msg("Enter a valid proxy URL."))?;
    Ok(HttpProxy {
        mode: ProxyMode::Manual,
        url: url.to_string(),
    })
}

pub fn policy_from_preferences(prefs: &AppPrefs) -> AppResult<HttpPolicy> {
    let proxy = normalize_proxy(prefs.http_proxy.clone())?;
    match proxy.mode {
        ProxyMode::None => Ok(HttpPolicy::Direct),
        ProxyMode::System => Ok(HttpPolicy::System),
        ProxyMode::Manual => Proxy::all(proxy.url)
            .map(|proxy| HttpPolicy::Manual(Box::new(proxy)))
            .map_err(|_| AppError::msg("Enter a valid proxy URL.")),
    }
}

pub fn client_from_preferences(prefs: &AppPrefs) -> AppResult<Client> {
    // The updater selects this provider too, but avatars can be requested before a check.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    policy_from_preferences(prefs)?
        .apply(Client::builder())
        .user_agent(concat!("Rebasely/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| AppError::msg("Could not initialize the client HTTP connection."))
}

#[cfg(test)]
pub(crate) mod tests;
