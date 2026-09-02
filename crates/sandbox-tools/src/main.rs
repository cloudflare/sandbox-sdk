mod read_file;

use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::path::Path;

fn main() {
    if let Err(error) = run(std::env::args_os().skip(1), io::stdout().lock()) {
        eprintln!("sandbox-shim: {error}");
        std::process::exit(1);
    }
}

fn run(mut args: impl Iterator<Item = OsString>, mut output: impl Write) -> Result<(), String> {
    let Some(command) = args.next() else {
        return Err("missing command".into());
    };

    if command != OsStr::new("read") {
        return Err("unknown command".into());
    }

    let Some(path) = args.next() else {
        return Err("read requires a path".into());
    };
    if args.next().is_some() {
        return Err("read accepts exactly one path".into());
    }

    read_file::stream(Path::new(&path), &mut output).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_commands_without_writing_protocol_bytes() {
        let mut output = Vec::new();
        let result = run([OsString::from("write")].into_iter(), &mut output);

        assert_eq!(result.unwrap_err(), "unknown command");
        assert!(output.is_empty());
    }
}
