use std::fs;
use std::io::{Read, Write};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
fn read_command_separates_control_and_content() {
    let temp = TempDir::new();
    let path = temp.0.join("content.bin");
    fs::write(&path, b"hello\0sandbox").unwrap();

    let output = Command::new(SHIM)
        .args(["read", path.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"hello\0sandbox");
    assert_eq!(output.stderr, b"SBXF\x01\x00\0\0\0\0SBXF\x01\x00\0\0\0\0");
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
    assert!(output.stdout.is_empty());
    assert_eq!(&output.stderr[..6], b"SBXF\x01\x01");
    assert_eq!(
        i32::from_le_bytes(output.stderr[10..14].try_into().unwrap()),
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
    assert!(output.stdout.is_empty());
    assert_eq!(&output.stderr[..10], b"SBXF\x01\x00\0\0\0\0");
    assert_eq!(&output.stderr[10..16], b"SBXF\x01\x01");
    assert_eq!(
        i32::from_le_bytes(output.stderr[20..24].try_into().unwrap()),
        21
    );
}

#[test]
fn stat_command_emits_file_metadata() {
    let temp = TempDir::new();
    let path = temp.0.join("content.bin");
    fs::write(&path, b"metadata").unwrap();

    let output = Command::new(SHIM)
        .args(["stat", path.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(&output.stdout[..6], b"SBXF\x01\x02");
    assert_eq!(
        u32::from_le_bytes(output.stdout[6..10].try_into().unwrap()),
        45
    );
    assert_eq!(output.stdout[10], 0);
    assert_eq!(
        u64::from_le_bytes(output.stdout[11..19].try_into().unwrap()),
        8
    );
}

#[test]
fn read_directory_command_emits_all_entries() {
    let temp = TempDir::new();
    for name in ["charlie", "alpha", "bravo"] {
        fs::write(temp.0.join(name), b"").unwrap();
    }

    let output = Command::new(SHIM)
        .args(["read-directory", temp.0.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(&output.stdout[..6], b"SBXF\x01\x02");
    let payload_length = u32::from_le_bytes(output.stdout[6..10].try_into().unwrap()) as usize;
    assert_eq!(payload_length, output.stdout.len() - 10);
    assert_eq!(
        u32::from_le_bytes(output.stdout[10..14].try_into().unwrap()),
        3
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("alpha"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("bravo"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("charlie"));
}

#[test]
fn rename_command_moves_the_source() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    let destination = temp.0.join("destination");
    fs::write(&source, b"content").unwrap();

    let output = Command::new(SHIM)
        .args([
            "rename",
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"SBXF\x01\x00\0\0\0\0");
    assert!(output.stderr.is_empty());
    assert!(!source.exists());
    assert_eq!(fs::read(destination).unwrap(), b"content");
}

#[test]
fn remove_command_removes_a_file() {
    let temp = TempDir::new();
    let path = temp.0.join("content.bin");
    fs::write(&path, b"content").unwrap();

    let output = Command::new(SHIM)
        .args(["remove", path.to_str().unwrap()])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"SBXF\x01\x00\0\0\0\0");
    assert!(output.stderr.is_empty());
    assert!(!path.exists());
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
    assert_eq!(&opening, b"SBXF\x01\x00\0\0\0\0");

    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"streamed content").unwrap();
    drop(stdin);

    let mut terminal = Vec::new();
    stdout.read_to_end(&mut terminal).unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(terminal, b"SBXF\x01\x00\0\0\0\0");
    assert_eq!(fs::read(path).unwrap(), b"streamed content");
}

#[test]
#[cfg(target_os = "linux")]
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
    assert_eq!(&output.stdout[..16], b"SBXF\x01\x00\0\0\0\0SBXF\x01\x01");
    assert_eq!(
        i32::from_le_bytes(output.stdout[20..24].try_into().unwrap()),
        28
    );
}

#[test]
#[cfg(target_os = "linux")]
fn s3_mount_command_selects_a_route_before_waiting_for_acknowledgement() {
    let temp = TempDir::new();
    let request = serde_json::json!({
        "protocolVersion": 1,
        "candidateRouteId": "candidate-route",
        "mountPath": temp.0.to_str().unwrap(),
        "configuration": {
            "source": {
                "type": "s3",
                "endpoint": "http://minio:9000/",
                "region": "us-east-1",
                "bucket": "models"
            },
            "access": "read-only",
            "s3fsOptions": []
        }
    });
    let mut child = Command::new(SHIM)
        .args(["s3-mount", "mount", &request.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();

    let opening = read_data_frame(&mut stdout);
    let opening: serde_json::Value = serde_json::from_slice(&opening).unwrap();
    assert_eq!(opening["value"]["kind"], "route");
    assert_eq!(opening["value"]["routeId"], "candidate-route");
    assert!(child.try_wait().unwrap().is_none());

    let mut inspection = Command::new(SHIM)
        .args(["s3-mount", "inspect", temp.0.to_str().unwrap()])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    wait_for_flock_waiter(&mut inspection);

    child.stdin.take().unwrap().write_all(&[1]).unwrap();
    let terminal = read_data_frame(&mut stdout);
    let terminal: serde_json::Value = serde_json::from_slice(&terminal).unwrap();
    assert_eq!(terminal["ok"], false);
    assert_eq!(terminal["error"]["kind"], "failed");
    assert!(child.wait().unwrap().success());

    let inspection = wait_with_output(inspection);
    let inspection = read_data_frame(&mut inspection.stdout.as_slice());
    let inspection: serde_json::Value = serde_json::from_slice(&inspection).unwrap();
    assert_eq!(inspection["value"]["state"]["kind"], "stale");
    assert_eq!(
        inspection["value"]["state"]["marker"]["routeId"],
        "candidate-route"
    );

    let mut cleanup = Command::new(SHIM)
        .args(["s3-mount", "unmount", temp.0.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut cleanup_stdout = cleanup.stdout.take().unwrap();
    let selection = read_data_frame(&mut cleanup_stdout);
    let selection: serde_json::Value = serde_json::from_slice(&selection).unwrap();
    assert_eq!(selection["value"]["routeId"], "candidate-route");
    assert!(cleanup.try_wait().unwrap().is_none());

    cleanup.stdin.take().unwrap().write_all(&[1]).unwrap();
    let terminal = read_data_frame(&mut cleanup_stdout);
    let terminal: serde_json::Value = serde_json::from_slice(&terminal).unwrap();
    assert_eq!(terminal["ok"], true);
    assert_eq!(terminal["value"], serde_json::Value::Null);
    assert!(cleanup.wait().unwrap().success());
}

#[cfg(target_os = "linux")]
fn read_data_frame(input: &mut impl Read) -> Vec<u8> {
    let mut header = [0; 10];
    input.read_exact(&mut header).unwrap();
    assert_eq!(&header[..6], b"SBXF\x01\x02");
    let length = u32::from_le_bytes(header[6..10].try_into().unwrap()) as usize;
    let mut payload = vec![0; length];
    input.read_exact(&mut payload).unwrap();
    payload
}

#[cfg(target_os = "linux")]
fn wait_for_flock_waiter(child: &mut Child) {
    let pid = child.id().to_string();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            child.try_wait().unwrap().is_none(),
            "inspection exited before waiting for the lifecycle lock"
        );
        let locks = fs::read_to_string("/proc/locks").unwrap();
        if locks
            .lines()
            .any(|line| line.contains("->") && line.split_whitespace().any(|field| field == pid))
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "inspection did not wait for the lifecycle lock"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn wait_with_output(mut child: Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let _ = child.wait();
            panic!("inspection did not finish within the test deadline");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn usage_errors_emit_no_protocol_bytes() {
    let output = Command::new(SHIM).arg("unknown").output().unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
