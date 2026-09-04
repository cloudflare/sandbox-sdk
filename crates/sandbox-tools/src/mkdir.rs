use crate::protocol::{write_file_error, write_success};

use std::ffi::OsString;
use std::fs::DirBuilder;
use std::io::Write;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    output: &mut impl Write,
) -> Result<(), String> {
    let Some(path) = args.next() else {
        return Err("mkdir requires a path".into());
    };
    let recursive = match args.next() {
        None => false,
        Some(option) if option == "--recursive" => true,
        Some(_) => return Err("mkdir accepts only --recursive after the path".into()),
    };
    if args.next().is_some() {
        return Err("mkdir accepts one path and optional --recursive".into());
    }

    match DirBuilder::new().recursive(recursive).create(path) {
        Ok(()) => write_success(output),
        Err(error) => write_file_error(output, &error),
    }
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::fs;
    use std::path::PathBuf;

    fn execute(path: PathBuf, recursive: bool) -> Vec<u8> {
        let mut args = vec![path.into_os_string()];
        if recursive {
            args.push(OsString::from("--recursive"));
        }
        let mut output = Vec::new();
        run(args.into_iter(), &mut output).unwrap();
        output
    }

    fn assert_errno(output: &[u8], errno: i32) {
        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(
            i32::from_le_bytes(output[10..14].try_into().unwrap()),
            errno
        );
    }

    #[test]
    fn implements_directory_creation_semantics() {
        let temp = TempDir::new();
        let single = temp.0.join("single");
        let nested = temp.0.join("parent/child");

        assert_eq!(execute(single.clone(), false), b"SBXF\x01\x00\0\0\0\0");
        assert!(single.is_dir());
        assert_eq!(execute(nested.clone(), true), b"SBXF\x01\x00\0\0\0\0");
        assert!(nested.is_dir());
        assert_eq!(execute(single.clone(), true), b"SBXF\x01\x00\0\0\0\0");

        assert_errno(&execute(single, false), 17);
    }

    #[test]
    fn reports_native_creation_errors() {
        let temp = TempDir::new();
        let path = temp.0.join("file");
        fs::write(&path, b"").unwrap();

        assert_errno(&execute(path, true), 17);
        assert_errno(&execute(temp.0.join("missing/child"), false), 2);
    }

    #[test]
    fn command_validates_internal_arguments() {
        let mut output = Vec::new();
        let missing = run(std::iter::empty(), &mut output);
        let unknown = run(
            [OsString::from("/tmp/dir"), OsString::from("--unknown")].into_iter(),
            &mut output,
        );
        let extra = run(
            [
                OsString::from("/tmp/dir"),
                OsString::from("--recursive"),
                OsString::from("extra"),
            ]
            .into_iter(),
            &mut output,
        );

        assert_eq!(missing.unwrap_err(), "mkdir requires a path");
        assert_eq!(
            unknown.unwrap_err(),
            "mkdir accepts only --recursive after the path"
        );
        assert_eq!(
            extra.unwrap_err(),
            "mkdir accepts one path and optional --recursive"
        );
        assert!(output.is_empty());
    }
}
