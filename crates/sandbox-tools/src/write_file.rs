use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

const SUCCESS_HEADER: &[u8; 6] = b"SBXF\x01\x00";
const FILE_ERROR_HEADER: &[u8; 6] = b"SBXF\x01\x01";
const EIO: i32 = 5;

pub(crate) fn stream(path: &Path, mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    let mut file = match File::create(path) {
        Ok(file) => file,
        Err(error) => return write_error(&mut output, &error),
    };

    output.write_all(SUCCESS_HEADER)?;
    output.flush()?;

    if let Err(error) = io::copy(&mut input, &mut file).and_then(|_| file.flush()) {
        return write_error(&mut output, &error);
    }

    output.write_all(SUCCESS_HEADER)
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
    use std::sync::atomic::{AtomicU64, Ordering};
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
                "sandbox-shim-write-{}-{nonce}-{sequence}",
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

    #[test]
    fn creates_and_truncates_files_between_success_frames() {
        let temp = TempDir::new();
        let path = temp.0.join("data.bin");
        fs::write(&path, b"old bytes").unwrap();
        let mut output = Vec::new();

        stream(&path, &b"new\0bytes"[..], &mut output).unwrap();

        assert_eq!(output, b"SBXF\x01\x00SBXF\x01\x00");
        assert_eq!(fs::read(path).unwrap(), b"new\0bytes");
    }

    #[test]
    fn frames_open_errors_without_consuming_input() {
        struct Unreadable;

        impl Read for Unreadable {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                panic!("input must not be read when opening fails");
            }
        }

        let temp = TempDir::new();
        let mut output = Vec::new();

        stream(&temp.0, Unreadable, &mut output).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), 21);
    }

    #[test]
    fn frames_write_failures_after_the_opening_success() {
        struct FailingInput;

        impl Read for FailingInput {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::from_raw_os_error(28))
            }
        }

        let temp = TempDir::new();
        let mut output = Vec::new();

        stream(&temp.0.join("data"), FailingInput, &mut output).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x00");
        assert_eq!(&output[6..12], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[12..16].try_into().unwrap()), 28);
    }
}
