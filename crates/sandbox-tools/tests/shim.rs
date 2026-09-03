use std::fs;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const SHIM: &str = env!("CARGO_BIN_EXE_sandbox-shim");
static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "sandbox-shim-integration-{}-{nonce}-{sequence}",
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

#[test]
fn read_command_emits_protocol_and_content() {
    let temp = TempDir::new();
    let path = temp.0.join("content.bin");
    fs::write(&path, b"hello\0sandbox").unwrap();

    let output = Command::new(SHIM)
        .args(["read", path.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        output.stdout,
        b"SBXF\x02\x00\0\0\0\0SBXF\x02\x02\x0d\0\0\0hello\0sandboxSBXF\x02\x00\0\0\0\0"
    );
}

#[test]
fn read_command_emits_native_open_error() {
    let temp = TempDir::new();
    let path = temp.0.join("missing");

    let output = Command::new(SHIM)
        .args(["read", path.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(&output.stdout[..6], b"SBXF\x02\x01");
    assert_eq!(
        i32::from_le_bytes(output.stdout[10..14].try_into().unwrap()),
        2
    );
}

#[test]
fn read_command_emits_native_read_error() {
    let temp = TempDir::new();

    let output = Command::new(SHIM)
        .args(["read", temp.0.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(&output.stdout[..10], b"SBXF\x02\x00\0\0\0\0");
    assert_eq!(&output.stdout[10..16], b"SBXF\x02\x01");
    assert_eq!(
        i32::from_le_bytes(output.stdout[20..24].try_into().unwrap()),
        21
    );
}

#[test]
fn write_command_acknowledges_open_before_consuming_stdin() {
    let temp = TempDir::new();
    let path = temp.0.join("content.bin");
    let mut child = Command::new(SHIM)
        .args(["write", path.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut opening = [0; 10];

    stdout.read_exact(&mut opening).unwrap();
    assert_eq!(&opening, b"SBXF\x02\x00\0\0\0\0");

    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"streamed content").unwrap();
    drop(stdin);

    let mut terminal = Vec::new();
    stdout.read_to_end(&mut terminal).unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(terminal, b"SBXF\x02\x00\0\0\0\0");
    assert_eq!(fs::read(path).unwrap(), b"streamed content");
}

#[test]
fn write_command_emits_native_destination_error() {
    let mut child = Command::new(SHIM)
        .args(["write", "/dev/full"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"content").unwrap();

    let output = child.wait_with_output().unwrap();

    assert!(output.status.success());
    assert_eq!(&output.stdout[..16], b"SBXF\x02\x00\0\0\0\0SBXF\x02\x01");
    assert_eq!(
        i32::from_le_bytes(output.stdout[20..24].try_into().unwrap()),
        28
    );
}

#[test]
fn usage_errors_emit_no_protocol_bytes() {
    let output = Command::new(SHIM).arg("unknown").output().unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
