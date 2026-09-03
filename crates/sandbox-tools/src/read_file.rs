use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

const SUCCESS_HEADER: &[u8; 6] = b"SBXF\x01\x00";
const FILE_ERROR_HEADER: &[u8; 6] = b"SBXF\x01\x01";
const EIO: i32 = 5;
pub(crate) fn stream(path: &Path, mut output: impl Write) -> io::Result<()> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) => return write_error(&mut output, &error),
    };

    output.write_all(SUCCESS_HEADER)?;
    io::copy(&mut file, &mut output)?;
    Ok(())
}

fn write_error(mut output: impl Write, error: &io::Error) -> io::Result<()> {
    output.write_all(FILE_ERROR_HEADER)?;
    output.write_all(&error.raw_os_error().unwrap_or(EIO).to_le_bytes())?;
    output.write_all(error.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn read(path: &Path) -> Vec<u8> {
        let mut output = Vec::new();
        stream(path, &mut output).expect("framed read should succeed");
        output
    }

    #[test]
    fn streams_regular_file_bytes_after_success_header() {
        let temp = TempDir::new();
        let path = temp.0.join("data.bin");
        let data = b"hello\0sandbox\xff";
        fs::write(&path, data).unwrap();

        let output = read(&path);

        assert_eq!(&output[..6], b"SBXF\x01\x00");
        assert_eq!(&output[6..], data);
    }

    #[test]
    fn frames_missing_file_errno() {
        let temp = TempDir::new();
        let output = read(&temp.0.join("missing"));

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), 2);
        assert!(!output[10..].is_empty());
    }

    #[test]
    fn frames_permission_errno() {
        let mut output = Vec::new();
        write_error(&mut output, &io::Error::from_raw_os_error(13)).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), 13);
    }

    #[test]
    fn frames_eio_when_an_error_has_no_os_errno() {
        let mut output = Vec::new();
        write_error(&mut output, &io::Error::other("read failed")).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), EIO);
    }

    #[test]
    fn reports_directory_failure_after_the_open_succeeds() {
        let temp = TempDir::new();
        let mut output = Vec::new();

        let error = stream(&temp.0, &mut output).unwrap_err();

        assert_eq!(error.raw_os_error(), Some(21));
        assert_eq!(output, b"SBXF\x01\x00");
    }

    #[test]
    fn follows_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new();
        let target = temp.0.join("target");
        let link = temp.0.join("link");
        fs::write(&target, b"linked").unwrap();
        symlink(&target, &link).unwrap();

        let output = read(&link);

        assert_eq!(&output[..6], b"SBXF\x01\x00");
        assert_eq!(&output[6..], b"linked");
    }

    #[test]
    fn streams_fifo_bytes_after_a_writer_connects() {
        let temp = TempDir::new();
        let path = temp.0.join("pipe");
        let status = Command::new("mkfifo").arg(&path).status().unwrap();
        assert!(status.success());

        let (sender, receiver) = mpsc::channel();
        let read_path = path.clone();
        thread::spawn(move || sender.send(read(&read_path)).unwrap());
        fs::write(path, b"from fifo").unwrap();
        let output = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("FIFO read should finish after its writer closes");

        assert_eq!(&output[..6], b"SBXF\x01\x00");
        assert_eq!(&output[6..], b"from fifo");
    }

    #[test]
    fn streams_large_files_in_bounded_writes() {
        struct CountingWriter {
            total: usize,
            largest_write: usize,
        }

        impl Write for CountingWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.total += bytes.len();
                self.largest_write = self.largest_write.max(bytes.len());
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let temp = TempDir::new();
        let path = temp.0.join("large.bin");
        let size = 2 * 1024 * 1024;
        fs::write(&path, vec![7; size]).unwrap();
        let mut output = CountingWriter {
            total: 0,
            largest_write: 0,
        };

        stream(&path, &mut output).unwrap();

        assert_eq!(output.total, size + 6);
        assert!(output.largest_write < size);
    }
}
