//! Answers git and ssh credential prompts from the app's UI.
//!
//! Git runs `GIT_ASKPASS` and ssh runs `SSH_ASKPASS` with the prompt as the only
//! argument and read the answer from its stdout. Both point at this executable;
//! in that mode it forwards the prompt over loopback to the running app, which
//! asks the user or answers an operation-owned SSH key prompt.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

const ENV_ENDPOINT: &str = "REBASELY_ASKPASS";
const ENV_ACTIVITY: &str = "REBASELY_ASKPASS_ACTIVITY";
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 32;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(100);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const SECRET_PROMPT_TIMEOUT: Duration = Duration::from_secs(30);

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

fn random_token() -> Option<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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
    let Some(token) = random_token() else {
        return;
    };
    let server = Server {
        port: addr.port(),
        token,
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

struct SecretState {
    secret: Option<Zeroizing<String>>,
    connection: Option<TcpStream>,
}

/// A bounded, operation-owned askpass endpoint. Only the random endpoint token
/// reaches the child environment; operation-owned zeroizing buffers hold the passphrase.
pub(crate) struct SecretPrompt {
    endpoint: String,
    executable: String,
    state: Arc<Mutex<SecretState>>,
    stopping: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl SecretPrompt {
    pub(crate) fn new(secret: &str) -> AppResult<Self> {
        let started = Instant::now();
        Self::with_policy(secret, MAX_CONNECTIONS, move || {
            started.elapsed() >= SECRET_PROMPT_TIMEOUT
        })
    }

    fn with_policy(
        secret: &str,
        connection_limit: usize,
        expired: impl Fn() -> bool + Send + 'static,
    ) -> AppResult<Self> {
        if secret.len() > 1023 {
            return Err(AppError::msg("The passphrase is too long."));
        }
        if secret.contains(['\r', '\n', '\0']) {
            return Err(AppError::msg("The passphrase must fit on a single line."));
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = random_token()
            .ok_or_else(|| AppError::msg("Could not secure the credential prompt."))?;
        let state = Arc::new(Mutex::new(SecretState {
            secret: Some(Zeroizing::new(secret.to_string())),
            connection: None,
        }));
        let stopping = Arc::new(AtomicBool::new(false));
        let owned_state = state.clone();
        let owned_stopping = stopping.clone();
        let endpoint = format!("{port}:{token}");
        let executable = helper_executable()?;
        let worker = thread::spawn(move || {
            let mut accepted = 0;
            while !owned_stopping.load(Ordering::Acquire)
                && !expired()
                && accepted < connection_limit
            {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(_) => break,
                };
                accepted += 1;
                // Accepted sockets can inherit the listener's nonblocking mode on Windows.
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                let Ok(connection) = stream.try_clone() else {
                    continue;
                };
                {
                    let mut state = owned_state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    if state.secret.is_none() || owned_stopping.load(Ordering::Acquire) {
                        break;
                    }
                    state.connection = Some(connection);
                }
                let reply = (|| {
                    stream.set_read_timeout(Some(SOCKET_POLL_INTERVAL)).ok()?;
                    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).ok()?;
                    let request = credential_io(
                        "private request read",
                        read_socket_message_cancellable(
                            &mut stream,
                            Instant::now() + HANDSHAKE_TIMEOUT,
                            Some(&owned_stopping),
                        ),
                    )?;
                    let mut parts = request.splitn(3, '\n');
                    if parts.next() != Some(token.as_str()) || parts.next() != Some("ssh-keygen") {
                        return None;
                    }
                    let state = owned_state
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    let secret = state.secret.as_ref()?;
                    Some(Zeroizing::new(format!("1{}", secret.as_str())))
                })();
                if let Some(reply) = reply {
                    let _ =
                        credential_io("private reply write", stream.write_all(reply.as_bytes()));
                }
                owned_state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .connection = None;
            }
            owned_state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .secret = None;
        });
        Ok(Self {
            endpoint,
            executable: crate::git::strip_verbatim_prefix(&executable.to_string_lossy()),
            state,
            stopping,
            worker: Some(worker),
        })
    }

    pub(crate) fn environment(&self) -> Vec<(&'static str, String)> {
        vec![
            ("SSH_ASKPASS", self.executable.clone()),
            ("SSH_ASKPASS_REQUIRE", "force".to_string()),
            ("DISPLAY", "rebasely-askpass".to_string()),
            (ENV_ENDPOINT, self.endpoint.clone()),
            (ENV_ACTIVITY, "ssh-keygen".to_string()),
        ]
    }
}

impl Drop for SecretPrompt {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.secret = None;
            if let Some(connection) = state.connection.take() {
                let _ = connection.shutdown(Shutdown::Both);
            }
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn helper_executable() -> std::io::Result<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(executable) = test_helper_executable() {
        return Ok(executable);
    }
    std::env::current_exe()
}

#[cfg(test)]
pub(crate) fn test_helper_executable() -> Option<std::path::PathBuf> {
    let current = std::env::current_exe().ok()?;
    let directory = current.parent()?.parent()?;
    let executable = directory.join(if cfg!(windows) {
        "rebasely.exe"
    } else {
        "rebasely"
    });
    executable.is_file().then_some(executable)
}

fn serve(listener: TcpListener, token: String, emit: Emit) {
    struct ConnectionGuard(Arc<Mutex<usize>>);
    impl Drop for ConnectionGuard {
        fn drop(&mut self) {
            *self.0.lock().unwrap_or_else(|err| err.into_inner()) -= 1;
        }
    }
    let connections = Arc::new(Mutex::new(0));
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut count = connections.lock().unwrap_or_else(|err| err.into_inner());
            if *count >= MAX_CONNECTIONS {
                continue;
            }
            *count += 1;
            drop(count);
            let guard = ConnectionGuard(connections.clone());
            let emit = emit.clone();
            let token = token.clone();
            thread::spawn(move || {
                let _guard = guard;
                handle(stream, &emit, &token);
            });
        }
    });
}

#[cfg(test)]
fn read_message(reader: impl Read) -> std::io::Result<String> {
    let mut message = String::new();
    reader
        .take(MAX_MESSAGE_BYTES as u64 + 1)
        .read_to_string(&mut message)?;
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Credential message is too large.",
        ));
    }
    Ok(message)
}

fn read_socket_message(
    stream: &mut TcpStream,
    deadline: Instant,
) -> std::io::Result<Zeroizing<String>> {
    read_socket_message_cancellable(stream, deadline, None)
}

fn read_socket_message_cancellable(
    stream: &mut TcpStream,
    deadline: Instant,
    stopping: Option<&AtomicBool>,
) -> std::io::Result<Zeroizing<String>> {
    read_socket_message_using(stream, deadline, stopping, |stream, buffer| {
        stream.read(buffer)
    })
}

fn read_socket_message_using(
    stream: &mut TcpStream,
    deadline: Instant,
    stopping: Option<&AtomicBool>,
    mut read: impl FnMut(&mut TcpStream, &mut [u8]) -> std::io::Result<usize>,
) -> std::io::Result<Zeroizing<String>> {
    let mut message = Zeroizing::new(Vec::with_capacity(MAX_MESSAGE_BYTES + 1));
    let mut buffer = Zeroizing::new([0_u8; 4096]);
    loop {
        if stopping.is_some_and(|stopping| stopping.load(Ordering::Acquire)) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Credential prompt cancelled.",
            ));
        }
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Credential message timed out.",
            ));
        }
        // Callers configure a short polling timeout before half-closing the
        // connection. Darwin rejects later socket-option changes once both
        // directions are shut, even when the final reply bytes are readable.
        let limit = buffer.len().min(MAX_MESSAGE_BYTES + 1 - message.len());
        let read = match read(stream, &mut buffer[..limit]) {
            Ok(read) => read,
            // Interrupted reads have not consumed bytes. Re-enter the outer
            // loop so cancellation and the total deadline are checked again.
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(error) => return Err(error),
        };
        if read == 0 {
            break;
        }
        message.extend_from_slice(&buffer[..read]);
        if message.len() > MAX_MESSAGE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Credential message is too large.",
            ));
        }
    }
    let text = std::str::from_utf8(&message)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(Zeroizing::new(text.to_string()))
}

fn credential_io<T>(stage: &str, result: std::io::Result<T>) -> Option<T> {
    if let Err(error) = &result {
        #[cfg(test)]
        eprintln!(
            "Credential transport {stage} failed: kind={:?}, os={:?}.",
            error.kind(),
            error.raw_os_error()
        );
        #[cfg(not(test))]
        let _ = (stage, error);
    }
    result.ok()
}

fn handle(mut stream: TcpStream, emit: &Emit, token: &str) {
    if stream.set_read_timeout(Some(SOCKET_POLL_INTERVAL)).is_err()
        || stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
    {
        return;
    }
    let Some(request) = credential_io(
        "prompt request read",
        read_socket_message(&mut stream, Instant::now() + HANDSHAKE_TIMEOUT),
    ) else {
        return;
    };
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
        prompt: crate::error::redact_credentials(&prompt),
        activity_id,
    });
    let answer = receiver.recv_timeout(PROMPT_TIMEOUT).ok().flatten();
    pending()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&id);
    let reply = match answer {
        Some(text) => {
            let text = Zeroizing::new(text);
            Zeroizing::new(format!("1{}", text.as_str()))
        }
        None => Zeroizing::new("0".to_string()),
    };
    let _ = credential_io("prompt reply write", stream.write_all(reply.as_bytes()));
}

pub fn answer(id: u64, answer: Option<String>) -> AppResult<()> {
    if answer
        .as_ref()
        .is_some_and(|text| text.len() >= MAX_MESSAGE_BYTES || text.contains(['\r', '\n', '\0']))
    {
        return Err(AppError::msg(
            "Credential responses must fit on a single line.",
        ));
    }
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
    let env = vec![
        ("GIT_ASKPASS".to_string(), server.exe.clone()),
        ("SSH_ASKPASS".to_string(), server.exe.clone()),
        // OpenSSH 8.4+ uses SSH_ASKPASS when SSH_ASKPASS_REQUIRE=force, without
        // a DISPLAY. A fake DISPLAY=:0 makes pinentry and ssh try a dead X server.
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
            let _ = writeln!(stdout, "{}", answer.as_str());
            let _ = stdout.flush();
            0
        }
        None => 1,
    })
}

fn ask(port: &str, token: &str, activity: &str, prompt: &str) -> Option<Zeroizing<String>> {
    let port: u16 = port.parse().ok()?;
    if token.is_empty()
        || token.contains(['\r', '\n', '\0'])
        || activity.contains(['\r', '\n', '\0'])
    {
        return None;
    }
    let request = format!("{token}\n{activity}\n{prompt}");
    if request.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let mut stream = credential_io("connect", TcpStream::connect(("127.0.0.1", port)))?;
    credential_io(
        "request write timeout",
        stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)),
    )?;
    credential_io(
        "reply read timeout",
        stream.set_read_timeout(Some(SOCKET_POLL_INTERVAL)),
    )?;
    credential_io("request write", stream.write_all(request.as_bytes()))?;
    credential_io("request half close", stream.shutdown(Shutdown::Write))?;
    let reply = credential_io(
        "reply read",
        read_socket_message(
            &mut stream,
            Instant::now() + PROMPT_TIMEOUT + HANDSHAKE_TIMEOUT,
        ),
    )?;
    reply
        .strip_prefix('1')
        .map(|text| Zeroizing::new(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_messages_reject_oversized_or_invalid_utf8_payloads() {
        assert!(read_message(vec![b'x'; MAX_MESSAGE_BYTES + 1].as_slice()).is_err());
        assert!(read_message([0xff_u8].as_slice()).is_err());
        assert_eq!(
            read_message(b"small message".as_slice()).unwrap(),
            "small message"
        );
        let first = random_token().unwrap();
        let second = random_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn credential_messages_enforce_a_total_deadline_for_slow_senders() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let writer = thread::spawn(move || {
            for _ in 0..50 {
                if sender.write_all(b"x").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        let (mut receiver, _) = listener.accept().unwrap();
        receiver
            .set_read_timeout(Some(SOCKET_POLL_INTERVAL))
            .unwrap();
        let started = Instant::now();
        assert!(read_socket_message(&mut receiver, started + Duration::from_millis(80)).is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(receiver);
        writer.join().unwrap();
    }

    #[test]
    fn credential_replies_remain_readable_after_both_socket_directions_close() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client.set_read_timeout(Some(SOCKET_POLL_INTERVAL)).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut request = Vec::new();
        server.read_to_end(&mut request).unwrap();
        server.write_all(b"1example response").unwrap();
        server.shutdown(Shutdown::Write).unwrap();
        drop(server);

        let reply = read_socket_message(&mut client, Instant::now() + HANDSHAKE_TIMEOUT).unwrap();
        assert_eq!(reply.as_str(), "1example response");
        // EOF is now observed, so Darwin considers both directions shut. Reading
        // again must return EOF without attempting another SO_RCVTIMEO update.
        let eof = read_socket_message(&mut client, Instant::now() + HANDSHAKE_TIMEOUT).unwrap();
        assert!(eof.is_empty());
    }

    #[test]
    fn interrupted_credential_reads_preserve_bytes_and_check_cancellation() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        let mut payload = std::io::Cursor::new(b"example response");
        let mut calls = 0;
        let reply = read_socket_message_using(
            &mut client,
            Instant::now() + HANDSHAKE_TIMEOUT,
            None,
            |_, buffer| {
                calls += 1;
                if calls == 1 || calls == 3 {
                    Err(std::io::ErrorKind::Interrupted.into())
                } else {
                    payload.read(buffer)
                }
            },
        )
        .unwrap();
        assert_eq!(reply.as_str(), "example response");
        assert_eq!(calls, 4);

        let stopping = AtomicBool::new(false);
        let error = read_socket_message_using(
            &mut client,
            Instant::now() + HANDSHAKE_TIMEOUT,
            Some(&stopping),
            |_, _| {
                stopping.store(true, Ordering::Release);
                Err(std::io::ErrorKind::Interrupted.into())
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(error.to_string(), "Credential prompt cancelled.");
    }

    #[test]
    fn invalid_responses_do_not_consume_a_waiting_prompt() {
        let id = u64::MAX;
        let (sender, receiver) = mpsc::channel();
        pending().lock().unwrap().insert(id, sender);
        assert!(answer(id, Some("first\nsecond".into())).is_err());
        assert!(answer(id, Some("bad\0response".into())).is_err());
        answer(id, Some("response".into())).unwrap();
        assert_eq!(receiver.recv().unwrap().as_deref(), Some("response"));
    }

    #[test]
    fn private_prompts_authenticate_requests_without_exporting_the_secret() {
        let secret = "example protected passphrase";
        let prompt = SecretPrompt::new(secret).unwrap();
        let environment = prompt.environment();
        assert!(environment.iter().all(|(_, value)| !value.contains(secret)));
        assert!(environment
            .iter()
            .any(|(name, value)| *name == "SSH_ASKPASS_REQUIRE" && value == "force"));
        let (port, token) = prompt.endpoint.split_once(':').unwrap();
        assert!(ask(port, "wrong-token", "ssh-keygen", "Passphrase:").is_none());
        assert!(ask(port, token, "other-operation", "Passphrase:").is_none());
        for _ in 0..2 {
            let answer = ask(port, token, "ssh-keygen", "Passphrase:").unwrap();
            assert_eq!(answer.as_str(), secret);
        }
        for invalid in ["first\nsecond", "first\rsecond", "bad\0value"] {
            assert!(SecretPrompt::new(invalid).is_err());
        }
        assert!(SecretPrompt::new(&"x".repeat(1024)).is_err());
    }

    #[test]
    fn private_prompt_drop_clears_the_secret_and_interrupts_pending_connections() {
        let prompt = SecretPrompt::new("example protected passphrase").unwrap();
        let state = prompt.state.clone();
        let port = prompt
            .endpoint
            .split_once(':')
            .unwrap()
            .0
            .parse::<u16>()
            .unwrap();
        let mut connection = TcpStream::connect(("127.0.0.1", port)).unwrap();
        connection.write_all(b"incomplete request").unwrap();
        let started = Instant::now();
        while state.lock().unwrap().connection.is_none() {
            assert!(started.elapsed() < Duration::from_secs(2));
            thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        drop(prompt);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(state.lock().unwrap().secret.is_none());
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn private_prompts_limit_the_number_of_requests() {
        // Freeze expiry so this test exercises the request budget independently
        // of scheduling delays in a concurrently running integration suite.
        let limit = 3;
        let prompt =
            SecretPrompt::with_policy("example protected passphrase", limit, || false).unwrap();
        let (port, token) = prompt.endpoint.split_once(':').unwrap();
        let started = Instant::now();
        for request in 1..=limit {
            assert!(
                ask(port, token, "ssh-keygen", "Passphrase:").is_some(),
                "Request {request} of {limit} failed after {:?}; expiry=false (frozen), worker_finished={}, secret_present={}.",
                started.elapsed(),
                prompt.worker.as_ref().is_some_and(|worker| worker.is_finished()),
                prompt.state.lock().unwrap().secret.is_some()
            );
        }
        assert!(ask(port, token, "ssh-keygen", "Passphrase:").is_none());
        assert!(prompt.state.lock().unwrap().secret.is_none());
    }

    #[test]
    fn private_prompts_expire_independently_of_the_request_limit() {
        let expired = Arc::new(AtomicBool::new(false));
        let owned_expired = expired.clone();
        let mut prompt =
            SecretPrompt::with_policy("example protected passphrase", MAX_CONNECTIONS, move || {
                owned_expired.load(Ordering::Acquire)
            })
            .unwrap();
        let (port, token) = prompt.endpoint.split_once(':').unwrap();
        assert!(ask(port, token, "ssh-keygen", "Passphrase:").is_some());
        expired.store(true, Ordering::Release);
        prompt.worker.take().unwrap().join().unwrap();
        assert!(prompt.state.lock().unwrap().secret.is_none());
        assert!(ask(port, token, "ssh-keygen", "Passphrase:").is_none());
    }

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
        assert_eq!(
            password.as_ref().map(|answer| answer.as_str()),
            Some("hunter2")
        );
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
