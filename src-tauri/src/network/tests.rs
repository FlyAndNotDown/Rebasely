use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::*;

fn request_line(stream: &mut TcpStream, deadline: Instant, stopped: &AtomicBool) -> Option<String> {
    let mut headers = Vec::new();
    let mut buffer = [0; 1024];
    while headers.len() < 16 * 1024 && !stopped.load(Ordering::Relaxed) && Instant::now() < deadline
    {
        let remaining = (16 * 1024 - headers.len()).min(buffer.len());
        match stream.read(&mut buffer[..remaining]) {
            Ok(0) => return None,
            Ok(read) => {
                headers.extend_from_slice(&buffer[..read]);
                if headers.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let line = std::str::from_utf8(&headers).ok()?.split("\r\n").next()?;
                    let mut parts = line.split_whitespace();
                    if parts.next()? != "GET"
                        || parts.next()?.is_empty()
                        || !matches!(parts.next()?, "HTTP/1.1" | "HTTP/1.0")
                        || parts.next().is_some()
                    {
                        return None;
                    }
                    return Some(line.to_owned());
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::Interrupted
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return None,
        }
    }
    None
}

/// One finite loopback HTTP exchange; never changes process or system proxy settings.
pub(crate) struct HttpFixture {
    pub url: String,
    request: mpsc::Receiver<String>,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl HttpFixture {
    pub fn new(body: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let body = body.to_owned();
        let (send, request) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_millis(100)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        // Empty speculative connections and truncated requests are not exchanges.
                        let Some(request) = request_line(&mut stream, deadline, &stop) else {
                            continue;
                        };
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                        if stream.write_all(response.as_bytes()).is_err() {
                            continue;
                        }
                        let _ = send.send(request);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url,
            request,
            stopped,
            worker: Some(worker),
        }
    }

    pub fn request(&self) -> String {
        self.request.recv_timeout(Duration::from_secs(3)).unwrap()
    }
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[test]
fn http_fixture_ignores_abandoned_connections_and_requires_complete_headers() {
    let fixture = HttpFixture::new("complete response");
    let address = fixture.url.strip_prefix("http://").unwrap();
    drop(TcpStream::connect(address).unwrap());
    let mut incomplete = TcpStream::connect(address).unwrap();
    incomplete
        .write_all(b"GET /incomplete HTTP/1.1\r\nHost: fixture\r\n")
        .unwrap();
    drop(incomplete);
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .write_all(b"GET /fragmented HTTP/1.1\r\nHost: fixture\r\n")
        .unwrap();
    stream.write_all(b"Connection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.ends_with("complete response"));
    assert_eq!(fixture.request(), "GET /fragmented HTTP/1.1");
}

#[test]
fn old_preferences_default_to_system_routing_and_builtin_avatars() {
    let prefs: AppPrefs = serde_json::from_str("{}").unwrap();
    assert_eq!(prefs.http_proxy, HttpProxy::default());
    assert_eq!(prefs.avatar_provider, crate::prefs::AvatarProvider::Builtin);
    let serialized = serde_json::to_value(prefs).unwrap();
    assert_eq!(serialized["httpProxy"]["mode"], "system");
    assert_eq!(serialized["avatarProvider"], "builtin");
}

#[test]
fn manual_proxy_validation_is_strict_and_never_echoes_credentials() {
    for url in [
        "http://proxy.example.com:8080",
        "https://proxy.example.com",
        "socks5://proxy.example.com:1080",
        "socks5h://[::1]:1080",
    ] {
        assert!(normalize_proxy(HttpProxy {
            mode: ProxyMode::Manual,
            url: url.to_owned()
        })
        .is_ok());
    }
    for url in [
        "proxy.example.com:8080",
        "ftp://proxy.example.com",
        "http://proxy.example.com:0",
        "http://proxy.example.com/path",
        "http://proxy.example.com?token=fixture-secret",
        "http://alice:fixture-secret@proxy.example.com",
        "http://proxy.example.com#fragment",
        "http://proxy.example.com\n:8080",
    ] {
        let error = normalize_proxy(HttpProxy {
            mode: ProxyMode::Manual,
            url: url.to_owned(),
        })
        .unwrap_err()
        .to_string();
        assert!(!error.contains("fixture-secret"));
        assert!(!error.contains("alice"));
        assert!(!error.contains("proxy.example.com"));
    }
    for mode in [ProxyMode::None, ProxyMode::System] {
        assert!(normalize_proxy(HttpProxy {
            mode,
            url: "discarded".to_owned()
        })
        .unwrap()
        .url
        .is_empty());
    }
}

#[test]
fn client_http_uses_explicit_direct_or_manual_routes() {
    tauri::async_runtime::block_on(async {
        let origin = HttpFixture::new("direct");
        let prefs = AppPrefs {
            http_proxy: HttpProxy {
                mode: ProxyMode::None,
                url: String::new(),
            },
            ..AppPrefs::default()
        };
        let body = client_from_preferences(&prefs)
            .unwrap()
            .get(format!("{}/resource", origin.url))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "direct");
        assert_eq!(origin.request(), "GET /resource HTTP/1.1");

        let proxy = HttpFixture::new("proxied");
        let prefs = AppPrefs {
            http_proxy: HttpProxy {
                mode: ProxyMode::Manual,
                url: proxy.url.clone(),
            },
            ..AppPrefs::default()
        };
        let body = client_from_preferences(&prefs)
            .unwrap()
            .get("http://origin.example.test/resource")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "proxied");
        assert_eq!(
            proxy.request(),
            "GET http://origin.example.test/resource HTTP/1.1"
        );
    });
}
