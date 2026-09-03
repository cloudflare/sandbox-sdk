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
    mut data: impl Write,
    mut control: impl Write,
) -> Result<(), String> {
    let Some(command) = args.next() else {
        return Err("missing command".into());
    };

    match command.to_str() {
        Some("read") => read_file::run(args, &mut data, &mut control),
        Some("write") => write_file::run(args, input, &mut data),
        _ => Err("unknown command".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_commands_without_writing_protocol_bytes() {
        let mut data = Vec::new();
        let mut control = Vec::new();
        let result = run(
            [OsString::from("unknown")].into_iter(),
            io::empty(),
            &mut data,
            &mut control,
        );

        assert_eq!(result.unwrap_err(), "unknown command");
        assert!(data.is_empty());
        assert!(control.is_empty());
    }

    #[test]
    fn rejects_missing_commands_without_writing_protocol_bytes() {
        let mut data = Vec::new();
        let mut control = Vec::new();
        let result = run(std::iter::empty(), io::empty(), &mut data, &mut control);

        assert_eq!(result.unwrap_err(), "missing command");
        assert!(data.is_empty());
        assert!(control.is_empty());
    }
}
