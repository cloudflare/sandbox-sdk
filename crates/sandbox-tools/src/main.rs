mod protocol;
mod read_file;
#[cfg(test)]
mod test_support;
mod write_file;

use std::ffi::OsString;
use std::io::{self, Read, Write};

fn main() {
    if let Err(error) = run(
        std::env::args_os().skip(1),
        io::stdin().lock(),
        io::stdout().lock(),
        io::stderr().lock(),
    ) {
        eprintln!("sandbox-shim: {error}");
        std::process::exit(1);
    }
}

fn run(
    mut args: impl Iterator<Item = OsString>,
    input: impl Read,
    mut stdout: impl Write,
    mut stderr: impl Write,
) -> Result<(), String> {
    let Some(command) = args.next() else {
        return Err("missing command".into());
    };

    match command.to_str() {
        Some("read") => read_file::run(args, &mut stdout, &mut stderr),
        Some("write") => write_file::run(args, input, &mut stdout),
        _ => Err("unknown command".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_commands_without_writing_protocol_bytes() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let result = run(
            [OsString::from("unknown")].into_iter(),
            io::empty(),
            &mut stdout,
            &mut stderr,
        );

        assert_eq!(result.unwrap_err(), "unknown command");
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }

    #[test]
    fn rejects_missing_commands_without_writing_protocol_bytes() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let result = run(std::iter::empty(), io::empty(), &mut stdout, &mut stderr);

        assert_eq!(result.unwrap_err(), "missing command");
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }
}
