use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TempDir(pub(crate) std::path::PathBuf);

impl TempDir {
    pub(crate) fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "sandbox-shim-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("temp directory should be created");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn assert_file_error_errno(output: &[u8], errno: i32) {
    assert_eq!(&output[..6], b"SBXF\x01\x01");
    assert_eq!(
        i32::from_le_bytes(output[10..14].try_into().unwrap()),
        errno
    );
}
