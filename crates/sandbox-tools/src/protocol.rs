use std::io::{self, Write};

const MAGIC: &[u8; 4] = b"SBXF";
const VERSION: u8 = 2;
const SUCCESS: u8 = 0;
const FILE_ERROR: u8 = 1;
const DATA: u8 = 2;
const EIO: i32 = 5;

pub(crate) fn write_success(output: &mut impl Write) -> io::Result<()> {
    write_frame(output, SUCCESS, &[])
}

pub(crate) fn write_file_error(output: &mut impl Write, error: &io::Error) -> io::Result<()> {
    let detail = error.to_string();
    let length = 4usize
        .checked_add(detail.len())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "error detail is too large"))?;

    write_header(output, FILE_ERROR, length)?;
    output.write_all(&error.raw_os_error().unwrap_or(EIO).to_le_bytes())?;
    output.write_all(detail.as_bytes())?;
    output.flush()
}

pub(crate) fn write_data(output: &mut impl Write, data: &[u8]) -> io::Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    write_frame(output, DATA, data)
}

fn write_frame(output: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame payload is too large"))?;
    write_header(output, kind, length)?;
    output.write_all(payload)?;
    output.flush()
}

fn write_header(output: &mut impl Write, kind: u8, length: u32) -> io::Result<()> {
    output.write_all(MAGIC)?;
    output.write_all(&[VERSION, kind])?;
    output.write_all(&length.to_le_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_success() {
        let mut output = Vec::new();

        write_success(&mut output).unwrap();

        assert_eq!(output, b"SBXF\x02\x00\0\0\0\0");
    }

    #[test]
    fn encodes_data() {
        let mut output = Vec::new();

        write_data(&mut output, b"data").unwrap();

        assert_eq!(output, b"SBXF\x02\x02\x04\0\0\0data");
    }

    #[test]
    fn encodes_file_errors() {
        let mut output = Vec::new();

        write_file_error(&mut output, &io::Error::from_raw_os_error(13)).unwrap();

        assert_eq!(&output[..6], b"SBXF\x02\x01");
        assert_eq!(
            u32::from_le_bytes(output[6..10].try_into().unwrap()) as usize,
            output.len() - 10
        );
        assert_eq!(i32::from_le_bytes(output[10..14].try_into().unwrap()), 13);
        assert!(!output[14..].is_empty());
    }

    #[test]
    fn substitutes_eio_when_no_errno_exists() {
        let mut output = Vec::new();

        write_file_error(&mut output, &io::Error::other("operation failed")).unwrap();

        assert_eq!(i32::from_le_bytes(output[10..14].try_into().unwrap()), EIO);
    }
}
