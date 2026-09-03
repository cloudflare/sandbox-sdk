mod read_file;
mod write_file;

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::Path;

fn main() {
    if let Err(error) = run(
        std::env::args_os().skip(1),
        io::stdin().lock(),
        io::stdout().lock(),
    ) {
        eprintln!("sandbox-shim: {error}");
        std::process::exit(1);
    }
}

fn run(
    mut args: impl Iterator<Item = OsString>,
    input: impl Read,
    mut output: impl Write,
) -> Result<(), String> {
    let Some(command) = args.next() else {
        return Err("missing command".into());
    };

    let Some(path) = args.next() else {
        return Err("command requires a path".into());
    };
    if args.next().is_some() {
        return Err("command accepts exactly one path".into());
    }

    match command.to_str() {
        Some("read") => read_file::stream(Path::new(&path), &mut output),
        Some("write") => write_file::stream(Path::new(&path), input, &mut output),
        _ => return Err("unknown command".into()),
    }
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_commands_without_writing_protocol_bytes() {
        let mut output = Vec::new();
        let result = run(
            [OsString::from("unknown"), OsString::from("/file")].into_iter(),
            io::empty(),
            &mut output,
        );

        assert_eq!(result.unwrap_err(), "unknown command");
        assert!(output.is_empty());
    }
}
