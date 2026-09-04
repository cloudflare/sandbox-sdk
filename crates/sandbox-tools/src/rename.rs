use crate::protocol::{write_file_error, write_success};

use std::ffi::OsString;
use std::fs;
use std::io::Write;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    output: &mut impl Write,
) -> Result<(), String> {
    let Some(source) = args.next() else {
        return Err("rename requires a source path".into());
    };
    let Some(destination) = args.next() else {
        return Err("rename requires a destination path".into());
    };
    if args.next().is_some() {
        return Err("rename accepts exactly two paths".into());
    }

    match fs::rename(source, destination) {
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

    fn execute(source: OsString, destination: OsString) -> Vec<u8> {
        let mut output = Vec::new();
        run([source, destination].into_iter(), &mut output).unwrap();
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
    fn renames_paths_and_replaces_existing_files() {
        let temp = TempDir::new();
        let source = temp.0.join("source");
        let destination = temp.0.join("destination");
        fs::write(&source, b"source").unwrap();
        fs::write(&destination, b"destination").unwrap();

        assert_eq!(
            execute(
                source.clone().into_os_string(),
                destination.clone().into_os_string(),
            ),
            b"SBXF\x01\x00\0\0\0\0"
        );
        assert!(!source.exists());
        assert_eq!(fs::read(destination).unwrap(), b"source");
    }

    #[test]
    fn reports_native_rename_errors() {
        let temp = TempDir::new();

        assert_errno(
            &execute(
                temp.0.join("missing").into_os_string(),
                temp.0.join("destination").into_os_string(),
            ),
            2,
        );
    }

    #[test]
    fn command_validates_internal_arguments() {
        let mut output = Vec::new();
        let missing_source = run(std::iter::empty(), &mut output);
        let missing_destination = run([OsString::from("source")].into_iter(), &mut output);
        let extra = run(
            [
                OsString::from("source"),
                OsString::from("destination"),
                OsString::from("extra"),
            ]
            .into_iter(),
            &mut output,
        );

        assert_eq!(missing_source.unwrap_err(), "rename requires a source path");
        assert_eq!(
            missing_destination.unwrap_err(),
            "rename requires a destination path"
        );
        assert_eq!(extra.unwrap_err(), "rename accepts exactly two paths");
        assert!(output.is_empty());
    }
}
