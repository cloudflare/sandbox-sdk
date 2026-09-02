use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const MAGIC: &[u8; 4] = b"SBXF";
const PROTOCOL_VERSION: u8 = 1;
const STATUS_OK: u8 = 0;
const STATUS_FILE_ERROR: u8 = 1;
#[cfg(target_os = "linux")]
const O_NONBLOCK: i32 = 0x800;
#[cfg(all(unix, not(target_os = "linux")))]
const O_NONBLOCK: i32 = 0x4;

fn main() {
    if let Err(error) = run(std::env::args_os().skip(1), io::stdout().lock()) {
        eprintln!("sandbox-shim: {error}");
        std::process::exit(1);
    }
}

fn run(
    mut args: impl Iterator<Item = OsString>,
    mut output: impl Write,
) -> Result<(), String> {
    let Some(command) = args.next() else {
        return Err("missing command".into());
    };

    if command != OsStr::new("read") {
        return Err("unknown command".into());
    }

    let Some(path) = args.next() else {
        return Err("read requires a path".into());
    };
    if args.next().is_some() {
        return Err("read accepts exactly one path".into());
    }

    read_file(Path::new(&path), &mut output).map_err(|error| error.to_string())
}

fn read_file(path: &Path, mut output: impl Write) -> io::Result<()> {
    let mut open_options = File::options();
    open_options.read(true);
    #[cfg(unix)]
    open_options.custom_flags(O_NONBLOCK);

    let mut file = match open_options.open(path) {
        Ok(file) => file,
        Err(error) => return write_file_error(&mut output, &error),
    };

    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => return write_file_error(&mut output, &error),
    };

    if !metadata.is_file() {
        let errno = if metadata.is_dir() { 21 } else { 22 };
        return write_file_error(&mut output, &io::Error::from_raw_os_error(errno));
    }

    write_header(&mut output, STATUS_OK)?;
    io::copy(&mut file, &mut output)?;
    Ok(())
}

fn write_header(mut output: impl Write, status: u8) -> io::Result<()> {
    output.write_all(MAGIC)?;
    output.write_all(&[PROTOCOL_VERSION, status])
}

fn write_file_error(mut output: impl Write, error: &io::Error) -> io::Result<()> {
    write_header(&mut output, STATUS_FILE_ERROR)?;
    output.write_all(&error.raw_os_error().unwrap_or_default().to_le_bytes())?;
    output.write_all(error.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "sandbox-shim-{}-{nonce}",
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
        read_file(path, &mut output).expect("framed read should succeed");
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
        write_file_error(&mut output, &io::Error::from_raw_os_error(13)).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), 13);
    }

    #[test]
    fn rejects_directories_as_non_regular_files() {
        let temp = TempDir::new();
        let output = read(&temp.0);

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), 21);
    }

    #[cfg(unix)]
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

        read_file(&path, &mut output).unwrap();

        assert_eq!(output.total, size + 6);
        assert!(output.largest_write < size);
    }

    #[test]
    fn rejects_unknown_commands_without_writing_protocol_bytes() {
        let mut output = Vec::new();
        let result = run([OsString::from("write")].into_iter(), &mut output);

        assert_eq!(result.unwrap_err(), "unknown command");
        assert!(output.is_empty());
    }
}
