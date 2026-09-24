use crate::protocol::{write_file_error, write_success};

use std::ffi::OsString;
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    output: &mut impl Write,
) -> Result<(), String> {
    let Some(path) = args.next() else {
        return Err("remove requires a path".into());
    };
    let mut recursive = false;
    let mut force = false;
    for option in args {
        match option.to_str() {
            Some("--recursive") if !recursive => recursive = true,
            Some("--force") if !force => force = true,
            _ => return Err("remove accepts one path and optional --recursive and --force".into()),
        }
    }

    match remove(Path::new(&path), recursive, force) {
        Ok(()) => write_success(output),
        Err(error) => write_file_error(output, &error),
    }
    .map_err(|error| error.to_string())
}

fn remove(path: &Path, recursive: bool, force: bool) -> io::Result<()> {
    let result = if recursive {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => fs::remove_dir_all(path),
            Ok(_) => fs::remove_file(path),
            Err(error) => Err(error),
        }
    } else {
        fs::remove_file(path)
    };

    match result {
        Err(error) if force && target_is_missing(path, &error) => Ok(()),
        result => result,
    }
}

fn target_is_missing(path: &Path, error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
        && fs::symlink_metadata(path).is_err_and(|check| check.kind() == io::ErrorKind::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{TempDir, assert_file_error_errno};

    fn execute(path: &Path, recursive: bool, force: bool) -> Vec<u8> {
        let mut args = vec![path.as_os_str().to_owned()];
        if recursive {
            args.push(OsString::from("--recursive"));
        }
        if force {
            args.push(OsString::from("--force"));
        }
        let mut output = Vec::new();
        run(args.into_iter(), &mut output).unwrap();
        output
    }

    #[test]
    fn removes_files_and_recursive_directory_trees() {
        let temp = TempDir::new();
        let file = temp.0.join("file");
        let directory = temp.0.join("directory");
        fs::create_dir(&directory).unwrap();
        fs::write(&file, b"content").unwrap();
        fs::write(directory.join("nested"), b"content").unwrap();

        assert_eq!(execute(&file, false, false), b"SBXF\x01\x00\0\0\0\0");
        assert!(!file.exists());
        assert_eq!(execute(&directory, true, false), b"SBXF\x01\x00\0\0\0\0");
        assert!(!directory.exists());
    }

    #[test]
    fn non_recursive_removal_rejects_directories() {
        let temp = TempDir::new();
        let directory = temp.0.join("directory");
        fs::create_dir(&directory).unwrap();
        let expected_errno = fs::remove_file(&directory)
            .unwrap_err()
            .raw_os_error()
            .unwrap();

        assert_file_error_errno(&execute(&directory, false, false), expected_errno);
        assert!(directory.is_dir());
    }

    #[test]
    fn force_ignores_only_missing_targets() {
        let temp = TempDir::new();
        let missing = temp.0.join("missing");
        let directory = temp.0.join("directory");
        fs::create_dir(&directory).unwrap();
        let directory_errno = fs::remove_file(&directory)
            .unwrap_err()
            .raw_os_error()
            .unwrap();

        assert_file_error_errno(&execute(&missing, false, false), 2);
        assert_eq!(execute(&missing, false, true), b"SBXF\x01\x00\0\0\0\0");
        assert_file_error_errno(&execute(&directory, false, true), directory_errno);
        assert!(directory.is_dir());
    }

    #[test]
    fn force_does_not_hide_not_found_while_target_exists() {
        let temp = TempDir::new();
        let missing_error = io::Error::from_raw_os_error(2);

        assert!(!target_is_missing(&temp.0, &missing_error));
    }

    #[test]
    #[cfg(unix)]
    fn recursive_removal_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new();
        let tree = temp.0.join("tree");
        let external = temp.0.join("external");
        let root_link = temp.0.join("root-link");
        fs::create_dir(&tree).unwrap();
        fs::create_dir(&external).unwrap();
        fs::write(external.join("keep"), b"content").unwrap();
        symlink(&external, tree.join("link")).unwrap();
        symlink(&external, &root_link).unwrap();

        assert_eq!(execute(&root_link, true, false), b"SBXF\x01\x00\0\0\0\0");
        assert!(fs::symlink_metadata(&root_link).is_err());
        assert_eq!(fs::read(external.join("keep")).unwrap(), b"content");
        assert_eq!(execute(&tree, true, false), b"SBXF\x01\x00\0\0\0\0");
        assert!(!tree.exists());
        assert_eq!(fs::read(external.join("keep")).unwrap(), b"content");
    }

    #[test]
    fn command_validates_internal_arguments() {
        let mut output = Vec::new();
        let missing = run(std::iter::empty(), &mut output);
        let unknown = run(
            [OsString::from("/tmp/path"), OsString::from("--unknown")].into_iter(),
            &mut output,
        );
        let duplicate = run(
            [
                OsString::from("/tmp/path"),
                OsString::from("--force"),
                OsString::from("--force"),
            ]
            .into_iter(),
            &mut output,
        );

        assert_eq!(missing.unwrap_err(), "remove requires a path");
        assert_eq!(
            unknown.unwrap_err(),
            "remove accepts one path and optional --recursive and --force"
        );
        assert_eq!(
            duplicate.unwrap_err(),
            "remove accepts one path and optional --recursive and --force"
        );
        assert!(output.is_empty());
    }
}
