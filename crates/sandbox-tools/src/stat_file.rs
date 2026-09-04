use crate::file_type;
use crate::protocol::{write_data, write_file_error};

use std::ffi::OsString;
use std::fs::{self, Metadata};
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const PAYLOAD_LENGTH: usize = 45;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    follow_symlink: bool,
    output: &mut impl Write,
) -> Result<(), String> {
    let Some(path) = args.next() else {
        return Err(if follow_symlink {
            "stat requires a path".into()
        } else {
            "lstat requires a path".into()
        });
    };
    if args.next().is_some() {
        return Err(if follow_symlink {
            "stat accepts one path".into()
        } else {
            "lstat accepts one path".into()
        });
    }

    let metadata = if follow_symlink {
        fs::metadata(Path::new(&path))
    } else {
        fs::symlink_metadata(Path::new(&path))
    };
    write_metadata(metadata, output).map_err(|error| error.to_string())
}

fn write_metadata(metadata: io::Result<Metadata>, output: &mut impl Write) -> io::Result<()> {
    let metadata = match metadata {
        Ok(metadata) => metadata,
        Err(error) => return write_file_error(output, &error),
    };

    let mut payload = Vec::with_capacity(PAYLOAD_LENGTH);
    payload.push(file_type::encode(&metadata.file_type()));
    payload.extend_from_slice(&metadata.len().to_le_bytes());
    payload.extend_from_slice(&metadata.mode().to_le_bytes());
    payload.extend_from_slice(&metadata.uid().to_le_bytes());
    payload.extend_from_slice(&metadata.gid().to_le_bytes());
    payload.extend_from_slice(
        &timestamp_millis(metadata.atime(), metadata.atime_nsec())?.to_le_bytes(),
    );
    payload.extend_from_slice(
        &timestamp_millis(metadata.mtime(), metadata.mtime_nsec())?.to_le_bytes(),
    );
    payload.extend_from_slice(
        &timestamp_millis(metadata.ctime(), metadata.ctime_nsec())?.to_le_bytes(),
    );
    debug_assert_eq!(payload.len(), PAYLOAD_LENGTH);
    write_data(output, &payload)
}

fn timestamp_millis(seconds: i64, nanoseconds: i64) -> io::Result<i64> {
    seconds
        .checked_mul(1_000)
        .and_then(|seconds| seconds.checked_add(nanoseconds / 1_000_000))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "timestamp is out of range"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn payload(output: &[u8]) -> &[u8] {
        assert_eq!(&output[..6], b"SBXF\x01\x02");
        let length = u32::from_le_bytes(output[6..10].try_into().unwrap()) as usize;
        &output[10..10 + length]
    }

    #[test]
    fn encodes_complete_regular_file_metadata() {
        let temp = TempDir::new();
        let path = temp.0.join("data");
        fs::write(&path, b"hello").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let expected = fs::metadata(&path).unwrap();
        let mut output = Vec::new();

        write_metadata(Ok(expected.clone()), &mut output).unwrap();

        let data = payload(&output);
        assert_eq!(data.len(), PAYLOAD_LENGTH);
        assert_eq!(data[0], 0);
        assert_eq!(u64::from_le_bytes(data[1..9].try_into().unwrap()), 5);
        assert_eq!(
            u32::from_le_bytes(data[9..13].try_into().unwrap()),
            expected.mode()
        );
        assert_eq!(
            u32::from_le_bytes(data[13..17].try_into().unwrap()),
            expected.uid()
        );
        assert_eq!(
            u32::from_le_bytes(data[17..21].try_into().unwrap()),
            expected.gid()
        );
        assert_eq!(
            i64::from_le_bytes(data[21..29].try_into().unwrap()),
            timestamp_millis(expected.atime(), expected.atime_nsec()).unwrap()
        );
        assert_eq!(
            i64::from_le_bytes(data[29..37].try_into().unwrap()),
            timestamp_millis(expected.mtime(), expected.mtime_nsec()).unwrap()
        );
        assert_eq!(
            i64::from_le_bytes(data[37..45].try_into().unwrap()),
            timestamp_millis(expected.ctime(), expected.ctime_nsec()).unwrap()
        );
    }

    #[test]
    fn distinguishes_followed_and_unfollowed_symlinks() {
        let temp = TempDir::new();
        let target = temp.0.join("target");
        let link = temp.0.join("link");
        fs::write(&target, b"target").unwrap();
        symlink(&target, &link).unwrap();
        let mut followed = Vec::new();
        let mut unfollowed = Vec::new();

        run(
            [link.clone().into_os_string()].into_iter(),
            true,
            &mut followed,
        )
        .unwrap();
        run([link.into_os_string()].into_iter(), false, &mut unfollowed).unwrap();

        assert_eq!(payload(&followed)[0], 0);
        assert_eq!(payload(&unfollowed)[0], 2);
    }

    #[test]
    fn frames_missing_paths() {
        let temp = TempDir::new();
        let mut output = Vec::new();

        write_metadata(fs::metadata(temp.0.join("missing")), &mut output).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[10..14].try_into().unwrap()), 2);
    }

    #[test]
    fn commands_own_their_argument_shapes() {
        let mut output = Vec::new();

        assert_eq!(
            run(std::iter::empty(), true, &mut output).unwrap_err(),
            "stat requires a path"
        );
        assert_eq!(
            run(std::iter::empty(), false, &mut output).unwrap_err(),
            "lstat requires a path"
        );
        assert_eq!(
            run(
                [OsString::from("/file"), OsString::from("extra")].into_iter(),
                true,
                &mut output,
            )
            .unwrap_err(),
            "stat accepts one path"
        );
        assert!(output.is_empty());
    }
}
