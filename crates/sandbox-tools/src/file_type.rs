use std::fs::FileType;
use std::os::unix::fs::FileTypeExt;

pub(crate) fn encode(file_type: &FileType) -> u8 {
    if file_type.is_file() {
        0
    } else if file_type.is_dir() {
        1
    } else if file_type.is_symlink() {
        2
    } else if file_type.is_block_device() {
        3
    } else if file_type.is_char_device() {
        4
    } else if file_type.is_fifo() {
        5
    } else if file_type.is_socket() {
        6
    } else {
        unreachable!("Linux file type was not recognized")
    }
}
