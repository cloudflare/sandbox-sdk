//! `directory-backup <backup|restore> <REQUEST_JSON>`: saves one directory to the gateway as a
//! zstd-compressed tar stream, or restores one into a directory by extracting beside it and
//! swapping.
//!
//! One operation runs at a time per container. After taking the lock, the shim sends
//! `{"kind":"locked"}`, the package registers the operation's grant and writes one byte, and the
//! shim starts. It holds the lock until the package closes stdin after the final frame, so the
//! package replaces the grant before the next operation can register its own.

mod capture;
mod extract;
mod lifeline;
mod restore;
mod sys;
#[cfg(test)]
mod tests;
mod transfer;

use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use self::capture::Selection;
use self::lifeline::Lifeline;
use self::transfer::{Gateway, PART_SIZE, PartSink, Uploaded};
use crate::protocol;

const LOCK_PATH: &str = "/run/sandbox/directory-backups.lock";
/// zstd's `--fast=3`: on the smallest instance it was 1.45 times faster than level 1, for an
/// archive about 10% larger.
const COMPRESSION_LEVEL: i32 = -3;

/// Why an operation failed. Inside a reader or writer it travels as the payload of an
/// `io::Error`, so it survives zstd and tar unchanged; `Failure::reading` and
/// `Failure::writing` take it back out.
#[derive(Clone, Debug)]
pub(super) enum Failure {
    /// A Linux error, sent as a file error frame.
    File {
        errno: i32,
        detail: String,
    },
    Integrity(String),
    NotFound(String),
    Transfer(String),
    Protocol(String),
    /// Stdin closed: nobody is waiting for a result.
    Aborted,
}

impl Failure {
    /// The failure behind an error reading the archive, or a corrupt archive if none is.
    pub(super) fn reading(error: io::Error) -> Self {
        Self::carried_by(error, |error| {
            Self::Integrity(format!("the backup is corrupt: {error}"))
        })
    }

    /// The failure behind an error writing the archive, or a transfer failure if none is.
    pub(super) fn writing(error: io::Error) -> Self {
        Self::carried_by(error, |error| {
            Self::Transfer(format!("writing the archive failed: {error}"))
        })
    }

    fn carried_by(error: io::Error, otherwise: impl FnOnce(io::Error) -> Self) -> Self {
        match error.downcast::<Self>() {
            Ok(failure) => failure,
            Err(error) => otherwise(error),
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::File { detail, .. }
            | Self::Integrity(detail)
            | Self::NotFound(detail)
            | Self::Transfer(detail)
            | Self::Protocol(detail) => formatter.write_str(detail),
            Self::Aborted => formatter.write_str("the operation was aborted"),
        }
    }
}

impl std::error::Error for Failure {}

impl From<Failure> for io::Error {
    fn from(failure: Failure) -> Self {
        io::Error::other(failure)
    }
}

pub(super) fn file_failure(error: io::Error, path: &[u8]) -> Failure {
    Failure::File {
        errno: error.raw_os_error().unwrap_or(libc::EIO),
        detail: format!("{}: {error}", String::from_utf8_lossy(path)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupRequest {
    gateway: String,
    dir: String,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    gitignore: bool,
}

pub(crate) fn run(
    args: &[OsString],
    input: impl Read + Send + 'static,
    output: &mut impl Write,
) -> io::Result<()> {
    let command = args.first().and_then(|command| command.to_str());
    let request = args.get(1).map(|request| request.as_bytes());
    match (command, request, args.len()) {
        (Some("backup"), Some(request), 2) => operate(request, input, output, backup),
        (Some("restore"), Some(request), 2) => operate(request, input, output, restore::restore),
        _ => write_failure(
            output,
            Failure::Protocol(
                "usage: sandbox-shim directory-backup <backup|restore> <request>".into(),
            ),
        ),
    }
}

/// Every frame the shim sends is one of these, as JSON in a data frame.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Message<'a, Done> {
    Locked,
    Done(Done),
    Error { code: &'a str, detail: &'a str },
}

fn send<Done: Serialize>(output: &mut impl Write, message: &Message<'_, Done>) -> io::Result<()> {
    protocol::write_data(output, &serde_json::to_vec(message)?)
}

/// Parses the request, then runs `work` in a session. A request that doesn't parse fails before
/// the lock.
fn operate<Request: DeserializeOwned, Done: Serialize, W: Write>(
    request: &[u8],
    input: impl Read + Send + 'static,
    output: &mut W,
    work: impl FnOnce(&Request, &mut Session<'_, W>) -> Result<Done, Failure>,
) -> io::Result<()> {
    let request = match serde_json::from_slice::<Request>(request) {
        Ok(request) => request,
        Err(error) => {
            let detail = format!("invalid directory backup request: {error}");
            return write_failure(output, Failure::Protocol(detail));
        }
    };
    let mut session = Session {
        output,
        lifeline: Lifeline::start(input),
        lock: None,
    };
    match work(&request, &mut session) {
        Ok(done) => send(session.output, &Message::Done(done))?,
        // Once stdin has closed nobody reads the result, whatever the failure was.
        Err(_) if session.lifeline.aborted() => return Ok(()),
        Err(failure) => write_failure(session.output, failure)?,
    }
    session.lifeline.wait_for_close();
    drop(session.lock.take());
    Ok(())
}

/// One operation's stdout, lifeline, and hold on the container-wide lock.
struct Session<'a, W: Write> {
    output: &'a mut W,
    lifeline: Lifeline,
    lock: Option<File>,
}

impl<W: Write> Session<'_, W> {
    /// Waits for the container-wide lock, then for the package to register this operation's
    /// grant.
    fn lock(&mut self) -> Result<(), Failure> {
        let path = Path::new(LOCK_PATH);
        let failure = |error| file_failure(error, LOCK_PATH.as_bytes());
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory)
                .map_err(|error| file_failure(error, directory.as_os_str().as_bytes()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(failure)?;
        sys::lock_exclusive(&file).map_err(failure)?;
        self.lock = Some(file);
        send(self.output, &Message::<'_, ()>::Locked).map_err(|_| Failure::Aborted)?;
        if self.lifeline.wait_for_acknowledgement() {
            Ok(())
        } else {
            Err(Failure::Aborted)
        }
    }
}

fn write_failure(output: &mut impl Write, failure: Failure) -> io::Result<()> {
    let (code, detail) = match failure {
        Failure::File { errno, detail } => return protocol::write_errno(output, errno, &detail),
        Failure::Integrity(detail) => ("integrity", detail),
        Failure::NotFound(detail) => ("notFound", detail),
        Failure::Transfer(detail) => ("transfer", detail),
        Failure::Protocol(detail) => ("protocol", detail),
        Failure::Aborted => return Ok(()),
    };
    let message: Message<'_, ()> = Message::Error {
        code,
        detail: &detail,
    };
    send(output, &message)
}

fn absolute(dir: &str) -> Result<PathBuf, Failure> {
    if !dir.starts_with('/') || dir.contains('\0') {
        return Err(Failure::Protocol("dir must be an absolute path".into()));
    }
    Ok(PathBuf::from(dir))
}

fn backup<W: Write>(
    request: &BackupRequest,
    session: &mut Session<'_, W>,
) -> Result<Uploaded, Failure> {
    let root = absolute(&request.dir)?;
    // Fail before waiting for the lock. Capture reads the root again once it holds the lock.
    capture::root_status(&root)?;
    let selection = Selection::new(&root, &request.exclude, request.gitignore)?;
    session.lock()?;

    let lifeline = session.lifeline.clone();
    let gateway = Gateway::resolve(&request.gateway, lifeline.clone())?;
    let sink = PartSink::new(
        move |number, body| gateway.put_part(number, body),
        PART_SIZE,
        transfer::parallelism(),
    );
    let mut encoder =
        zstd::stream::write::Encoder::new(sink, COMPRESSION_LEVEL).map_err(Failure::writing)?;
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    if cpus > 1 {
        encoder
            .multithread(u32::try_from(cpus).unwrap_or(u32::MAX))
            .map_err(Failure::writing)?;
    }
    let aborted = || lifeline.aborted();
    let encoder = capture::capture(&root, &selection, encoder, &aborted)?;
    encoder.finish().map_err(Failure::writing)?.finish()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
