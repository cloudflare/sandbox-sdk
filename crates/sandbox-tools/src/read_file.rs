use crate::protocol::{write_file_error, write_success};

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

const BUFFER_SIZE: usize = 8 * 1024;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    output: &mut impl Write,
) -> Result<(), String> {
    let Some(path) = args.next() else {
        return Err("read requires a path".into());
    };
    if args.next().is_some() {
        return Err("read accepts exactly one path".into());
    }

    stream(Path::new(&path), output).map_err(|error| error.to_string())
}

fn stream(path: &Path, output: &mut impl Write) -> io::Result<()> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) => return write_file_error(output, &error),
    };
    let mut buffer = [0; BUFFER_SIZE];
    let first = match file.read(&mut buffer) {
        Ok(length) => length,
        Err(error) => return write_file_error(output, &error),
    };

    write_success(output)?;
    output.write_all(&buffer[..first])?;

    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 {
            return Ok(());
        }
        output.write_all(&buffer[..length])?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;
    use std::process::Command;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

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
    fn frames_directory_errno_before_success() {
        let temp = TempDir::new();
        let mut output = Vec::new();

        stream(&temp.0, &mut output).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), 21);
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

    #[test]
    fn command_owns_its_argument_shape() {
        let mut output = Vec::new();

        let missing = run(std::iter::empty(), &mut output);
        let extra = run(
            [OsString::from("/file"), OsString::from("extra")].into_iter(),
            &mut output,
        );

        assert_eq!(missing.unwrap_err(), "read requires a path");
        assert_eq!(extra.unwrap_err(), "read accepts exactly one path");
        assert!(output.is_empty());
    }
}
