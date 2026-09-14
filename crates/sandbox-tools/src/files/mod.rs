mod file_type;
mod mkdir;
mod read_directory;
mod read_file;
mod remove;
mod rename;
mod stat_file;
mod write_file;

use std::ffi::OsString;
use std::io::{Read, Write};

pub(crate) fn run(
    command: &str,
    args: impl Iterator<Item = OsString>,
    input: impl Read,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> Result<(), String> {
    match command {
        "mkdir" => mkdir::run(args, stdout),
        "read-directory" => read_directory::run(args, stdout),
        "read" => read_file::run(args, stdout, stderr),
        "remove" => remove::run(args, stdout),
        "rename" => rename::run(args, stdout),
        "lstat" => stat_file::run(args, false, stdout),
        "stat" => stat_file::run(args, true, stdout),
        "write" => write_file::run(args, input, stdout),
        _ => Err("unknown command".into()),
    }
}
