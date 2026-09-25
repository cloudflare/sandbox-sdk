mod directory_backup;
mod files;
mod http;
mod protocol;
mod s3_mount;
#[cfg(test)]
mod test_support;

use std::ffi::OsString;
use std::io::{self, Read, Write};

fn main() {
    // Stdin stays unlocked: a directory backup reads it on another thread.
    if let Err(error) = run(
        std::env::args_os().skip(1),
        io::stdin(),
        io::stdout().lock(),
        io::stderr().lock(),
    ) {
        eprintln!("sandbox-shim: {error}");
        std::process::exit(1);
    }
}

fn run(
    mut args: impl Iterator<Item = OsString>,
    mut input: impl Read + Send + 'static,
    mut stdout: impl Write,
    mut stderr: impl Write,
) -> Result<(), String> {
    let Some(command) = args.next() else {
        return Err("missing command".into());
    };

    match command.to_str() {
        Some("s3-mount") => {
            let arguments = args
                .map(|argument| {
                    argument
                        .into_string()
                        .map_err(|_| "s3-mount arguments must be UTF-8".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            s3_mount::run(&arguments, &mut input, &mut stdout).map_err(|error| error.to_string())
        }
        Some("directory-backup") => {
            let arguments: Vec<OsString> = args.collect();
            directory_backup::run(&arguments, input, &mut stdout).map_err(|error| error.to_string())
        }
        Some(command) => files::run(command, args, input, &mut stdout, &mut stderr),
        None => Err("unknown command".into()),
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
