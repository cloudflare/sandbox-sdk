use std::io::{self, Write};

const SUCCESS_HEADER: &[u8; 6] = b"SBXF\x01\x00";
const FILE_ERROR_HEADER: &[u8; 6] = b"SBXF\x01\x01";
const EIO: i32 = 5;

pub(crate) fn write_success(output: &mut impl Write) -> io::Result<()> {
    output.write_all(SUCCESS_HEADER)?;
    output.flush()
}

pub(crate) fn write_file_error(output: &mut impl Write, error: &io::Error) -> io::Result<()> {
    output.write_all(FILE_ERROR_HEADER)?;
    output.write_all(&error.raw_os_error().unwrap_or(EIO).to_le_bytes())?;
    output.write_all(error.to_string().as_bytes())?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_success() {
        let mut output = Vec::new();

        write_success(&mut output).unwrap();

        assert_eq!(output, b"SBXF\x01\x00");
    }

    #[test]
    fn encodes_file_errors() {
        let mut output = Vec::new();

        write_file_error(&mut output, &io::Error::from_raw_os_error(13)).unwrap();

        assert_eq!(&output[..6], b"SBXF\x01\x01");
        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), 13);
        assert!(!output[10..].is_empty());
    }

    #[test]
    fn substitutes_eio_when_no_errno_exists() {
        let mut output = Vec::new();

        write_file_error(&mut output, &io::Error::other("operation failed")).unwrap();

        assert_eq!(i32::from_le_bytes(output[6..10].try_into().unwrap()), EIO);
    }
}
