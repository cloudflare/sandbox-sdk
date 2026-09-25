//! Runs `sandbox-shim directory-backup` as a subprocess against a local stand-in for the
//! gateway, the way the package drives it.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SHIM: &str = env!("CARGO_BIN_EXE_sandbox-shim");
static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "sandbox-backup-integration-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct Store {
    parts: BTreeMap<u32, Vec<u8>>,
    object: Option<Vec<u8>>,
}

/// Accepts part uploads and serves ranges of `object`, as the gateway does for one grant.
struct FakeGateway {
    address: SocketAddr,
    store: Arc<Mutex<Store>>,
}

impl FakeGateway {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let store = Arc::new(Mutex::new(Store::default()));
        let shared = Arc::clone(&store);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let store = Arc::clone(&shared);
                std::thread::spawn(move || serve(stream, &store));
            }
        });
        Self { address, store }
    }

    fn authority(&self) -> String {
        self.address.to_string()
    }

    /// Joins the uploaded parts into the stored object, as completing the upload does.
    fn complete(&self) -> Vec<u8> {
        let mut store = self.store.lock().unwrap();
        let object: Vec<u8> = store.parts.values().flatten().copied().collect();
        store.object = Some(object.clone());
        object
    }
}

fn serve(stream: TcpStream, store: &Mutex<Store>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    reader.read_line(&mut request_line).unwrap();
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').unwrap();
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    let mut parts = request_line.split(' ');
    let (method, path) = (parts.next().unwrap(), parts.next().unwrap());
    let mut stream = stream;
    if method == "PUT" {
        let number: u32 = path.strip_prefix("/parts/").unwrap().parse().unwrap();
        let length: usize = header("content-length").unwrap().parse().unwrap();
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).unwrap();
        store.lock().unwrap().parts.insert(number, body);
        let reply = format!(r#"{{"etag":"etag-{number}"}}"#);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
            reply.len()
        )
        .unwrap();
        return;
    }
    let range = header("range").unwrap();
    let (first, last) = range
        .strip_prefix("bytes=")
        .unwrap()
        .split_once('-')
        .unwrap();
    let (first, last): (usize, usize) = (first.parse().unwrap(), last.parse().unwrap());
    let object = store.lock().unwrap().object.clone();
    let Some(object) = object else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return;
    };
    let end = (last + 1).min(object.len());
    let body = &object[first..end];
    let _ = write!(
        stream,
        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {first}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        end - 1,
        object.len(),
        body.len()
    );
    let _ = stream.write_all(body);
}

struct Operation {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: mpsc::Receiver<Frame>,
}

#[derive(Debug)]
enum Frame {
    Data(Value),
    FileError(i32),
}

impl Operation {
    fn start(command: &str, request: Value) -> Self {
        let mut child = Command::new(SHIM)
            .args(["directory-backup", command, &request.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (sender, frames) = mpsc::channel();
        std::thread::spawn(move || read_frames(stdout, &sender));
        Self {
            child,
            stdin,
            frames,
        }
    }

    fn frame(&self) -> Frame {
        self.frames
            .recv_timeout(Duration::from_secs(60))
            .expect("the shim should send a frame")
    }

    fn expect_locked(&mut self) {
        match self.frame() {
            Frame::Data(value) if value == json!({ "kind": "locked" }) => {}
            other => panic!("expected the locked frame, got {other:?}"),
        }
    }

    fn acknowledge(&mut self) {
        self.stdin.as_mut().unwrap().write_all(&[1]).unwrap();
    }

    /// Closes stdin, as the package does after the final frame, and waits for the exit code.
    fn close(mut self) -> i32 {
        drop(self.stdin.take());
        self.child.wait().unwrap().code().unwrap_or(-1)
    }
}

fn read_frames(mut stdout: ChildStdout, sender: &mpsc::Sender<Frame>) {
    loop {
        let mut header = [0u8; 10];
        if stdout.read_exact(&mut header).is_err() {
            return;
        }
        assert_eq!(&header[..5], b"SBXF\x01");
        let length = u32::from_le_bytes(header[6..10].try_into().unwrap()) as usize;
        let mut payload = vec![0u8; length];
        stdout.read_exact(&mut payload).unwrap();
        let frame = match header[5] {
            1 => Frame::FileError(i32::from_le_bytes(payload[..4].try_into().unwrap())),
            2 => Frame::Data(serde_json::from_slice(&payload).unwrap()),
            kind => panic!("unexpected frame kind {kind}"),
        };
        if sender.send(frame).is_err() {
            return;
        }
    }
}

/// Bytes that don't compress, so the archive spans more than one 16 MiB part.
fn incompressible(length: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

fn backup(gateway: &FakeGateway, dir: &Path, exclude: &[&str]) -> Value {
    let mut operation = Operation::start(
        "backup",
        json!({ "gateway": gateway.authority(), "dir": dir, "exclude": exclude }),
    );
    operation.expect_locked();
    operation.acknowledge();
    let Frame::Data(done) = operation.frame() else {
        panic!("backup failed");
    };
    assert_eq!(operation.close(), 0);
    done
}

fn restore_request(gateway: &FakeGateway, dir: &Path, size: usize, sha256: &str) -> Value {
    json!({ "gateway": gateway.authority(), "dir": dir, "size": size, "sha256": sha256 })
}

fn siblings(parent: &Path) -> Vec<String> {
    fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".sandbox-restore-"))
        .collect()
}

#[test]
fn backs_up_in_parts_and_restores_over_an_existing_directory() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    fs::create_dir_all(source.join("node_modules")).unwrap();
    let large = incompressible(20 * 1024 * 1024);
    fs::write(source.join("large.bin"), &large).unwrap();
    fs::write(source.join("small.txt"), b"small").unwrap();
    fs::write(source.join("node_modules/skip.js"), b"skip").unwrap();
    let gateway = FakeGateway::start();

    let done = backup(&gateway, &source, &["node_modules/"]);
    let object = gateway.complete();

    assert_eq!(done["kind"], "done");
    assert_eq!(done["size"], object.len());
    let sha256: String = Sha256::digest(&object)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(done["sha256"], sha256);
    assert_eq!(
        done["parts"],
        json!([
            { "partNumber": 1, "etag": "etag-1" },
            { "partNumber": 2, "etag": "etag-2" },
        ])
    );

    let target = temp.0.join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("old.txt"), b"old").unwrap();
    let mut operation = Operation::start(
        "restore",
        restore_request(&gateway, &target, object.len(), &sha256),
    );
    operation.expect_locked();
    operation.acknowledge();
    assert!(matches!(operation.frame(), Frame::Data(value) if value == json!({ "kind": "done" })));
    assert_eq!(operation.close(), 0);

    assert_eq!(fs::read(target.join("large.bin")).unwrap(), large);
    assert_eq!(fs::read(target.join("small.txt")).unwrap(), b"small");
    assert!(!target.join("old.txt").exists());
    assert!(!target.join("node_modules").exists());
    assert!(siblings(&temp.0).is_empty());
}

#[test]
fn restores_into_a_missing_directory() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file"), b"content").unwrap();
    let gateway = FakeGateway::start();
    let done = backup(&gateway, &source, &[]);
    let object = gateway.complete();

    let target = temp.0.join("new");
    let mut operation = Operation::start(
        "restore",
        restore_request(
            &gateway,
            &target,
            object.len(),
            done["sha256"].as_str().unwrap(),
        ),
    );
    operation.expect_locked();
    operation.acknowledge();
    assert!(matches!(operation.frame(), Frame::Data(value) if value["kind"] == "done"));
    assert_eq!(operation.close(), 0);

    assert_eq!(fs::read(target.join("file")).unwrap(), b"content");
}

#[test]
fn a_mismatched_hash_leaves_the_target_untouched() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("new.txt"), b"new").unwrap();
    let gateway = FakeGateway::start();
    backup(&gateway, &source, &[]);
    let object = gateway.complete();
    let target = temp.0.join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("old.txt"), b"old").unwrap();

    let mut operation = Operation::start(
        "restore",
        restore_request(&gateway, &target, object.len(), &"0".repeat(64)),
    );
    operation.expect_locked();
    operation.acknowledge();
    let frame = operation.frame();
    assert_eq!(operation.close(), 0);

    assert!(matches!(frame, Frame::Data(value) if value["code"] == "integrity"));
    assert_eq!(fs::read(target.join("old.txt")).unwrap(), b"old");
    assert!(!target.join("new.txt").exists());
    assert!(siblings(&temp.0).is_empty());
}

#[test]
fn a_missing_object_is_not_found() {
    let temp = TempDir::new();
    let gateway = FakeGateway::start();

    let mut operation = Operation::start(
        "restore",
        restore_request(&gateway, &temp.0.join("target"), 100, &"0".repeat(64)),
    );
    operation.expect_locked();
    operation.acknowledge();
    let frame = operation.frame();
    assert_eq!(operation.close(), 0);

    assert!(matches!(frame, Frame::Data(value) if value["code"] == "notFound"));
    assert!(siblings(&temp.0).is_empty());
}

#[test]
fn reports_a_missing_directory_before_locking() {
    let temp = TempDir::new();
    let gateway = FakeGateway::start();

    let operation = Operation::start(
        "backup",
        json!({ "gateway": gateway.authority(), "dir": temp.0.join("missing") }),
    );

    assert!(matches!(operation.frame(), Frame::FileError(2)));
    assert_eq!(operation.close(), 0);
}

#[test]
fn closing_stdin_before_the_acknowledgement_ends_the_shim() {
    let temp = TempDir::new();
    let gateway = FakeGateway::start();

    let mut operation = Operation::start(
        "backup",
        json!({ "gateway": gateway.authority(), "dir": temp.0 }),
    );
    operation.expect_locked();
    operation.close();

    assert!(gateway.store.lock().unwrap().parts.is_empty());
}

#[test]
fn a_second_operation_waits_for_the_first_to_close_stdin() {
    let temp = TempDir::new();
    let gateway = FakeGateway::start();
    let request = json!({ "gateway": gateway.authority(), "dir": temp.0 });

    let mut first = Operation::start("backup", request.clone());
    first.expect_locked();
    let mut second = Operation::start("backup", request);
    first.acknowledge();
    assert!(matches!(first.frame(), Frame::Data(value) if value["kind"] == "done"));

    // The first shim still holds the lock until the package closes its stdin.
    assert!(
        second
            .frames
            .recv_timeout(Duration::from_millis(500))
            .is_err()
    );
    assert_eq!(first.close(), 0);
    second.expect_locked();
    second.acknowledge();
    assert!(matches!(second.frame(), Frame::Data(value) if value["kind"] == "done"));
    assert_eq!(second.close(), 0);
}
