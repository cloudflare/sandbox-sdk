use crate::file_type;
use crate::protocol::{write_data, write_file_error};

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

// sandbox-shim is a Linux container binary; Linux assigns EILSEQ errno 84.
const EILSEQ: i32 = 84;

pub(crate) fn run(
    mut args: impl Iterator<Item = OsString>,
    output: &mut impl Write,
) -> Result<(), String> {
    let Some(path) = args.next() else {
        return Err("read-directory requires a path".into());
    };
    if args.next().is_some() {
        return Err("read-directory accepts one path".into());
    }

    read_directory(Path::new(&path), output).map_err(|error| error.to_string())
}

fn read_directory(path: &Path, output: &mut impl Write) -> io::Result<()> {
    let directory = match fs::read_dir(path) {
        Ok(directory) => directory,
        Err(error) => return write_file_error(output, &error),
    };
    let mut count = 0u32;
    let mut payload = vec![0; 4];

    for result in directory {
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => return write_file_error(output, &error),
        };
        let name = entry.file_name();
        let name = name.as_os_str().as_bytes();
        if std::str::from_utf8(name).is_err() {
            return write_file_error(output, &io::Error::from_raw_os_error(EILSEQ));
        }
        let entry_type = match entry.file_type() {
            Ok(entry_type) => file_type::encode(&entry_type),
            Err(error) => return write_file_error(output, &error),
        };
        append_entry(&mut payload, name, entry_type)?;
        count = count.checked_add(1).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "too many directory entries")
        })?;
    }

    payload[..4].copy_from_slice(&count.to_le_bytes());
    write_data(output, &payload)
}

fn append_entry(payload: &mut Vec<u8>, name: &[u8], entry_type: u8) -> io::Result<()> {
    let name_length = u16::try_from(name.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file name is too long"))?;
    payload.push(entry_type);
    payload.extend_from_slice(&name_length.to_le_bytes());
    payload.extend_from_slice(name);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::collections::HashMap;
    use std::os::unix::fs::symlink;

    fn data_payload(output: &[u8]) -> &[u8] {
        assert_eq!(&output[..6], b"SBXF\x01\x02");
        let length = u32::from_le_bytes(output[6..10].try_into().unwrap()) as usize;
        &output[10..10 + length]
    }

    fn entries(payload: &[u8]) -> Vec<(&str, u8)> {
        let count = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
        let mut offset = 4;
        (0..count)
            .map(|_| {
                let kind = payload[offset];
                let length = u16::from_le_bytes(payload[offset + 1..offset + 3].try_into().unwrap())
                    as usize;
                offset += 3;
                let name = std::str::from_utf8(&payload[offset..offset + length]).unwrap();
                offset += length;
                (name, kind)
            })
            .collect()
    }

    #[test]
    fn preserves_entry_order() {
        let mut payload = vec![0; 4];
        append_entry(&mut payload, b"delta", 0).unwrap();
        append_entry(&mut payload, b"alpha", 1).unwrap();
        payload[..4].copy_from_slice(&2u32.to_le_bytes());

        assert_eq!(entries(&payload), [("delta", 0), ("alpha", 1)]);
    }

    #[test]
    fn reports_entry_types_without_following_symlinks() {
        let temp = TempDir::new();
        fs::write(temp.0.join("file"), b"").unwrap();
        fs::create_dir(temp.0.join("directory")).unwrap();
        symlink(temp.0.join("file"), temp.0.join("link")).unwrap();
        let mut output = Vec::new();

        read_directory(&temp.0, &mut output).unwrap();

        let entries: HashMap<_, _> = entries(data_payload(&output)).into_iter().collect();
        assert_eq!(entries["file"], 0);
        assert_eq!(entries["directory"], 1);
        assert_eq!(entries["link"], 2);
    }

    #[test]
    fn frames_directory_open_errors() {
        let temp = TempDir::new();
        let mut output = Vec::new();

        read_directory(&temp.0.join("missing"), &mut output).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[10..14].try_into().unwrap()), 2);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_non_utf8_entry_names_as_filesystem_errors() {
        use std::os::unix::ffi::OsStringExt;

        let temp = TempDir::new();
        fs::write(temp.0.join(OsString::from_vec(vec![0xff])), b"").unwrap();
        let mut output = Vec::new();

        read_directory(&temp.0, &mut output).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(
            i32::from_le_bytes(output[10..14].try_into().unwrap()),
            EILSEQ
        );
    }

    #[test]
    fn command_validates_internal_arguments() {
        let mut output = Vec::new();
        let missing = run(std::iter::empty(), &mut output);
        let extra = run(
            [OsString::from("/"), OsString::from("extra")].into_iter(),
            &mut output,
        );

        assert_eq!(missing.unwrap_err(), "read-directory requires a path");
        assert_eq!(extra.unwrap_err(), "read-directory accepts one path");
        assert!(output.is_empty());
    }
}
