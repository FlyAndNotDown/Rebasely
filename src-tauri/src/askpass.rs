//! Answers git and ssh credential prompts from the app's UI.
//!
//! Git runs `GIT_ASKPASS` and ssh runs `SSH_ASKPASS` with the prompt as the only
//! argument and read the answer from its stdout. Both point at this executable;
//! in that mode it forwards the prompt over loopback to the running app, which
//! asks the user and sends the answer back.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

const ENV_ENDPOINT: &str = "REBASELY_ASKPASS";
const ENV_ACTIVITY: &str = "REBASELY_ASKPASS_ACTIVITY";

struct Server {
    port: u16,
    token: String,
    exe: String,
}

static SERVER: OnceLock<Server> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<u64, mpsc::Sender<Option<String>>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<Option<String>>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptEvent {
    id: u64,
    prompt: String,
    activity_id: Option<String>,
}

fn random_token() -> String {
    (0..4)
        .map(|_| format!("{:016x}", RandomState::new().build_hasher().finish()))
        .collect()
}

pub fn start(app: &AppHandle) {
    if SERVER.get().is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else {
        return;
    };
    let Ok(addr) = listener.local_addr() else {
        return;
    };
    let server = Server {
        port: addr.port(),
        token: random_token(),
        exe: crate::git::strip_verbatim_prefix(&exe.to_string_lossy()),
    };
    let token = server.token.clone();
    if SERVER.set(server).is_err() {
        return;
    }
    let app = app.clone();
    serve(
        listener,
        token,
        Arc::new(move |event| {
            let _ = app.emit("askpass-prompt", event);
        }),
    );
}

type Emit = Arc<dyn Fn(PromptEvent) + Send + Sync>;

fn serve(listener: TcpListener, token: String, emit: Emit) {
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let emit = emit.clone();
            let token = token.clone();
            thread::spawn(move || handle(stream, &emit, &token));
        }
    });
}

fn handle(mut stream: TcpStream, emit: &Emit, token: &str) {
    let mut request = String::new();
    if stream.read_to_string(&mut request).is_err() {
        return;
    }
    let mut parts = request.splitn(3, '\n');
    if parts.next() != Some(token) {
        return;
    }
    let activity_id = parts.next().filter(|id| !id.is_empty()).map(str::to_string);
    let prompt = parts.next().unwrap_or("").trim().to_string();

    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    pending()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(id, sender);
    emit(PromptEvent {
        id,
        prompt,
        activity_id,
    });
    let answer = receiver.recv().ok().flatten();
    pending()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&id);
    let reply = match answer {
        Some(text) => format!("1{text}"),
        None => "0".to_string(),
    };
    let _ = stream.write_all(reply.as_bytes());
}

pub fn answer(id: u64, answer: Option<String>) -> AppResult<()> {
    let sender = pending()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&id)
        .ok_or_else(|| AppError::msg("That prompt is no longer waiting"))?;
    let _ = sender.send(answer);
    Ok(())
}

/// Environment that routes a git process's prompts to the app. Empty until the
/// server has started, so tests and early calls keep git's own behaviour.
pub fn git_env(activity_id: Option<&str>) -> Vec<(String, String)> {
    let Some(server) = SERVER.get() else {
        return Vec::new();
    };
    let mut env = vec![
        ("GIT_ASKPASS".to_string(), server.exe.clone()),
        ("SSH_ASKPASS".to_string(), server.exe.clone()),
        // OpenSSH only uses SSH_ASKPASS without a terminal when told to.
        ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
        (
            ENV_ENDPOINT.to_string(),
            format!("{}:{}", server.port, server.token),
        ),
        (
            ENV_ACTIVITY.to_string(),
            activity_id.unwrap_or_default().to_string(),
        ),
    ];
    if std::env::var_os("DISPLAY").is_none() {
        env.push(("DISPLAY".to_string(), ":0".to_string()));
    }
    env
}

/// When git or ssh launched this executable as its askpass helper, answers the
/// prompt and returns the exit code; otherwise returns None.
pub fn run_client() -> Option<i32> {
    let endpoint = std::env::var(ENV_ENDPOINT).ok()?;
    let (port, token) = endpoint.split_once(':')?;
    let activity = std::env::var(ENV_ACTIVITY).unwrap_or_default();
    let prompt = std::env::args_os()
        .nth(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(match ask(port, token, &activity, &prompt) {
        Some(answer) => {
            let mut stdout = std::io::stdout();
            let _ = writeln!(stdout, "{answer}");
            let _ = stdout.flush();
            0
        }
        None => 1,
    })
}

fn ask(port: &str, token: &str, activity: &str, prompt: &str) -> Option<String> {
    let port: u16 = port.parse().ok()?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream
        .write_all(format!("{token}\n{activity}\n{prompt}").as_bytes())
        .ok()?;
    stream.shutdown(Shutdown::Write).ok()?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).ok()?;
    reply.strip_prefix('1').map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_round_trip_through_the_loopback_server() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        serve(
            listener,
            "token".to_string(),
            Arc::new(move |event: PromptEvent| {
                record
                    .lock()
                    .unwrap()
                    .push((event.prompt.clone(), event.activity_id.clone()));
                let reply = event
                    .prompt
                    .starts_with("Password")
                    .then(|| "hunter2".to_string());
                thread::spawn(move || answer(event.id, reply).unwrap());
            }),
        );

        let password = ask(&port, "token", "fetch-1", "Password for 'https://host': ");
        assert_eq!(password.as_deref(), Some("hunter2"));
        assert_eq!(
            ask(&port, "token", "", "Username for 'https://host': "),
            None
        );
        assert_eq!(ask(&port, "wrong", "fetch-1", "Password: "), None);
        let seen = seen.lock().unwrap();
        assert_eq!(
            *seen,
            vec![
                (
                    "Password for 'https://host':".to_string(),
                    Some("fetch-1".to_string())
                ),
                ("Username for 'https://host':".to_string(), None),
            ]
        );
    }
}
