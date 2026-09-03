use crate::protocol::{write_file_error, write_success};

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

const BUFFER_SIZE: usize = 8 * 1024;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    data: &mut impl Write,
    control: &mut impl Write,
) -> Result<(), String> {
    let Some(path) = args.next() else {
        return Err("read requires a path".into());
    };
    if args.next().is_some() {
        return Err("read accepts exactly one path".into());
    }

    stream(Path::new(&path), data, control).map_err(|error| error.to_string())
}

fn stream(path: &Path, data: &mut impl Write, control: &mut impl Write) -> io::Result<()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => return write_file_error(control, &error),
    };

    stream_contents(file, data, control)
}

fn stream_contents(
    mut input: impl Read,
    data: &mut impl Write,
    control: &mut impl Write,
) -> io::Result<()> {
    write_success(control)?;
    let mut buffer = [0; BUFFER_SIZE];

    loop {
        let length = match input.read(&mut buffer) {
            Ok(length) => length,
            Err(error) => return write_file_error(control, &error),
        };
        if length == 0 {
            return write_success(control);
        }
        data.write_all(&buffer[..length])?;
        data.flush()?;
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

    fn frames(mut bytes: &[u8]) -> Vec<(u8, &[u8])> {
        let mut frames = Vec::new();
        while !bytes.is_empty() {
            assert_eq!(&bytes[..4], b"SBXF");
            assert_eq!(bytes[4], 1);
            let kind = bytes[5];
            let length = u32::from_le_bytes(bytes[6..10].try_into().unwrap()) as usize;
            frames.push((kind, &bytes[10..10 + length]));
            bytes = &bytes[10 + length..];
        }
        frames
    }

    fn read(path: &Path) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::new();
        let mut control = Vec::new();
        stream(path, &mut data, &mut control).expect("streamed read should succeed");
        (data, control)
    }

    #[test]
    fn streams_regular_file_bytes_between_success_frames() {
        let temp = TempDir::new();
        let path = temp.0.join("data.bin");
        let data = b"hello\0sandbox\xff";
        fs::write(&path, data).unwrap();

        let (output, control) = read(&path);

        assert_eq!(output, data);
        assert_eq!(frames(&control), vec![(0, &[][..]), (0, &[][..])]);
    }

    #[test]
    fn frames_missing_file_errno() {
        let temp = TempDir::new();
        let (output, control) = read(&temp.0.join("missing"));

        assert!(output.is_empty());
        let decoded = frames(&control);
        assert_eq!(decoded[0].0, 1);
        assert_eq!(i32::from_le_bytes(decoded[0].1[..4].try_into().unwrap()), 2);
        assert!(!decoded[0].1[4..].is_empty());
    }

    #[test]
    fn frames_directory_errno_after_opening_success() {
        let temp = TempDir::new();
        let mut output = Vec::new();
        let mut control = Vec::new();

        stream(&temp.0, &mut output, &mut control).unwrap();

        let decoded = frames(&control);
        assert_eq!(decoded[0], (0, &[][..]));
        assert_eq!(decoded[1].0, 1);
        assert_eq!(
            i32::from_le_bytes(decoded[1].1[..4].try_into().unwrap()),
            21
        );
    }

    #[test]
    fn frames_read_errors_after_streamed_data() {
        struct FailingReader(bool);

        impl Read for FailingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.0 {
                    return Err(io::Error::from_raw_os_error(5));
                }
                self.0 = true;
                buffer[..4].copy_from_slice(b"data");
                Ok(4)
            }
        }

        let mut output = Vec::new();
        let mut control = Vec::new();
        stream_contents(FailingReader(false), &mut output, &mut control).unwrap();

        assert_eq!(output, b"data");
        let decoded = frames(&control);
        assert_eq!(decoded[0], (0, &[][..]));
        assert_eq!(decoded[1].0, 1);
        assert_eq!(i32::from_le_bytes(decoded[1].1[..4].try_into().unwrap()), 5);
    }

    #[test]
    fn follows_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new();
        let target = temp.0.join("target");
        let link = temp.0.join("link");
        fs::write(&target, b"linked").unwrap();
        symlink(&target, &link).unwrap();

        let (output, control) = read(&link);

        assert_eq!(output, b"linked");
        assert_eq!(frames(&control), vec![(0, &[][..]), (0, &[][..])]);
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
        let (output, control) = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("FIFO read should finish after its writer closes");

        assert_eq!(output, b"from fifo");
        assert_eq!(frames(&control), vec![(0, &[][..]), (0, &[][..])]);
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
        let mut control = Vec::new();

        stream(&path, &mut output, &mut control).unwrap();

        assert_eq!(output.total, size);
        assert!(output.largest_write < size);
        assert_eq!(frames(&control), vec![(0, &[][..]), (0, &[][..])]);
    }

    #[test]
    fn command_owns_its_argument_shape() {
        let mut output = Vec::new();
        let mut control = Vec::new();

        let missing = run(std::iter::empty(), &mut output, &mut control);
        let extra = run(
            [OsString::from("/file"), OsString::from("extra")].into_iter(),
            &mut output,
            &mut control,
        );

        assert_eq!(missing.unwrap_err(), "read requires a path");
        assert_eq!(extra.unwrap_err(), "read accepts exactly one path");
        assert!(output.is_empty());
        assert!(control.is_empty());
    }
}
