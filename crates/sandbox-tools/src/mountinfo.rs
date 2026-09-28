//! Reads the mount table from `/proc/self/mountinfo`.

use std::io;

pub(crate) const PATH: &str = "/proc/self/mountinfo";

#[derive(Clone, Debug)]
pub(crate) struct MountEntry {
    pub(crate) mount_point: Vec<u8>,
    pub(crate) filesystem_type: String,
    pub(crate) source: String,
}

/// Parses a mount table. A malformed table is `InvalidData`.
pub(crate) fn parse(bytes: &[u8]) -> io::Result<Vec<MountEntry>> {
    let invalid = |detail: &str| io::Error::new(io::ErrorKind::InvalidData, detail);
    let mut entries = Vec::new();
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let fields: Vec<&[u8]> = line.split(|byte| *byte == b' ').collect();
        let separator = fields
            .iter()
            .position(|field| *field == b"-")
            .ok_or_else(|| invalid("invalid mountinfo entry"))?;
        if fields.len() <= separator + 2 || fields.len() <= 4 {
            return Err(invalid("invalid mountinfo entry"));
        }
        entries.push(MountEntry {
            mount_point: decode_field(fields[4])
                .ok_or_else(|| invalid("invalid mountinfo path escape"))?,
            filesystem_type: String::from_utf8_lossy(fields[separator + 1]).into_owned(),
            source: String::from_utf8_lossy(fields[separator + 2]).into_owned(),
        });
    }
    Ok(entries)
}

/// Decodes the octal escapes, such as `\040` for a space, that the kernel writes in paths.
fn decode_field(field: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::with_capacity(field.len());
    let mut index = 0;
    while index < field.len() {
        if field[index] == b'\\' {
            if index + 3 >= field.len()
                || !(b'0'..=b'3').contains(&field[index + 1])
                || !field[index + 2..=index + 3]
                    .iter()
                    .all(|byte| (b'0'..=b'7').contains(byte))
            {
                return None;
            }
            let value = (field[index + 1] - b'0') * 64
                + (field[index + 2] - b'0') * 8
                + (field[index + 3] - b'0');
            decoded.push(value);
            index += 4;
        } else {
            decoded.push(field[index]);
            index += 1;
        }
    }
    Some(decoded)
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::parse;

    #[test]
    fn parses_entries_and_decodes_paths() {
        let entries =
            parse(b"97 54 0:61 / /mnt/a\\040b rw,nosuid - fuse sandbox-s3-route-123 rw\n").unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].mount_point, b"/mnt/a b");
        assert_eq!(entries[0].filesystem_type, "fuse");
        assert_eq!(entries[0].source, "sandbox-s3-route-123");
    }

    #[test]
    fn rejects_invalid_escapes() {
        for line in [
            &b"97 54 0:61 / /mnt/a\\x rw - fuse source rw\n"[..],
            b"97 54 0:61 / /mnt/a\\777 rw - fuse source rw\n",
        ] {
            assert_eq!(parse(line).unwrap_err().kind(), io::ErrorKind::InvalidData);
        }
    }
}
