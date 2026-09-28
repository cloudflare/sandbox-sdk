use std::ffi::{CStr, CString};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
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

/// A mount made for one test and detached when dropped. Mounting needs a privileged
/// container, so without one the constructors return `None` and the test skips, unless
/// `SANDBOX_REQUIRE_MOUNTS` is set, as `npm run test:shim-mounts` sets it.
pub(crate) struct TestMount(CString);

impl TestMount {
    pub(crate) fn tmpfs(path: &Path) -> Option<Self> {
        Self::mount(c"tmpfs", path, c"tmpfs", 0)
    }

    /// Binds `source` at `path`, a mount on the same filesystem with the same device number.
    pub(crate) fn bind(source: &Path, path: &Path) -> Option<Self> {
        let source = CString::new(source.as_os_str().as_bytes()).unwrap();
        Self::mount(&source, path, c"", libc::MS_BIND)
    }

    fn mount(source: &CStr, path: &Path, filesystem: &CStr, flags: libc::c_ulong) -> Option<Self> {
        let target = CString::new(path.as_os_str().as_bytes()).unwrap();
        let filesystem = if filesystem.is_empty() {
            std::ptr::null()
        } else {
            filesystem.as_ptr()
        };
        // SAFETY: every string is NUL-terminated or null, and neither mount takes data.
        let result = unsafe {
            libc::mount(
                source.as_ptr(),
                target.as_ptr(),
                filesystem,
                flags,
                std::ptr::null(),
            )
        };
        if result == 0 {
            return Some(Self(target));
        }
        let error = io::Error::last_os_error();
        assert!(
            std::env::var_os("SANDBOX_REQUIRE_MOUNTS").is_none(),
            "cannot mount at {}: {error}",
            path.display()
        );
        eprintln!("skipped: cannot mount ({error})");
        None
    }
}

impl Drop for TestMount {
    fn drop(&mut self) {
        // SAFETY: the path is NUL-terminated.
        unsafe { libc::umount2(self.0.as_ptr(), libc::MNT_DETACH) };
    }
}
