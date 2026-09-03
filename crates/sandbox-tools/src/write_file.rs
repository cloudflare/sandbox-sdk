use crate::protocol::{write_file_error, write_success};

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

const BUFFER_SIZE: usize = 8 * 1024;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    input: impl Read,
    output: &mut impl Write,
) -> Result<(), String> {
    let Some(path) = args.next() else {
        return Err("write requires a path".into());
    };
    if args.next().is_some() {
        return Err("write accepts exactly one path".into());
    }

    stream(Path::new(&path), input, output).map_err(|error| error.to_string())
}

fn stream(path: &Path, mut input: impl Read, output: &mut impl Write) -> io::Result<()> {
    let mut file = match File::create(path) {
        Ok(file) => file,
        Err(error) => return write_file_error(output, &error),
    };

    write_success(output)?;
    let mut buffer = [0; BUFFER_SIZE];

    loop {
        let length = input.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        if let Err(error) = file.write_all(&buffer[..length]) {
            return write_file_error(output, &error);
        }
    }
    if let Err(error) = file.flush() {
        return write_file_error(output, &error);
    }
    drop(file);

    write_success(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;

    #[test]
    fn creates_and_truncates_files_between_success_frames() {
        let temp = TempDir::new();
        let path = temp.0.join("data.bin");
        fs::write(&path, b"old bytes").unwrap();
        let mut output = Vec::new();

        stream(&path, &b"new\0bytes"[..], &mut output).unwrap();

        assert_eq!(output, b"SBXF\x02\x00\0\0\0\0SBXF\x02\x00\0\0\0\0");
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

        assert_eq!(&output[..6], b"SBXF\x02\x01");
        assert_eq!(i32::from_le_bytes(output[10..14].try_into().unwrap()), 21);
    }

    #[test]
    fn input_failures_are_not_framed_as_filesystem_errors() {
        struct FailingInput;

        impl Read for FailingInput {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("stdin failed"))
            }
        }

        let temp = TempDir::new();
        let mut output = Vec::new();

        let error = stream(&temp.0.join("data"), FailingInput, &mut output).unwrap_err();

        assert_eq!(error.to_string(), "stdin failed");
        assert_eq!(output, b"SBXF\x02\x00\0\0\0\0");
    }

    #[test]
    fn frames_destination_failures_after_the_opening_success() {
        let mut output = Vec::new();

        stream(Path::new("/dev/full"), &b"content"[..], &mut output).unwrap();

        assert_eq!(&output[..10], b"SBXF\x02\x00\0\0\0\0");
        assert_eq!(&output[10..16], b"SBXF\x02\x01");
        assert_eq!(i32::from_le_bytes(output[20..24].try_into().unwrap()), 28);
    }

    #[test]
    fn command_owns_its_argument_shape() {
        let mut output = Vec::new();

        let missing = run(std::iter::empty(), io::empty(), &mut output);
        let extra = run(
            [OsString::from("/file"), OsString::from("extra")].into_iter(),
            io::empty(),
            &mut output,
        );

        assert_eq!(missing.unwrap_err(), "write requires a path");
        assert_eq!(extra.unwrap_err(), "write accepts exactly one path");
        assert!(output.is_empty());
    }
}
