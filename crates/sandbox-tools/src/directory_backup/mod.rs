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
mod sys;
#[cfg(test)]
mod tests;
mod transfer;

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use self::capture::Selection;
use self::extract::Extractor;
use self::lifeline::Lifeline;
use self::transfer::{Gateway, PART_SIZE, PartSink, RangeReader};
use crate::protocol;

const LOCK_PATH: &str = "/run/sandbox/directory-backups.lock";
/// zstd's `--fast=3`: on the smallest instance it was 1.45 times faster than level 1, for an
/// archive about 10% larger.
const COMPRESSION_LEVEL: i32 = -3;
const SIBLING_PREFIX: &str = ".sandbox-restore-";
const MAX_TRAILING_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreRequest {
    gateway: String,
    dir: String,
    size: u64,
    sha256: String,
}

pub(crate) fn run(
    args: &[OsString],
    input: impl Read + Send + 'static,
    output: &mut impl Write,
) -> io::Result<()> {
    let command = args.first().and_then(|command| command.to_str());
    let request = args.get(1).map(|request| request.as_bytes());
    match (command, request, args.len()) {
        (Some("backup"), Some(request), 2) => match parse::<BackupRequest>(request) {
            Ok(request) => Session::run(input, output, Path::new(LOCK_PATH), |session| {
                backup(&request, session)
            }),
            Err(failure) => write_failure(output, failure),
        },
        (Some("restore"), Some(request), 2) => match parse::<RestoreRequest>(request) {
            Ok(request) => Session::run(input, output, Path::new(LOCK_PATH), |session| {
                restore(&request, session)
            }),
            Err(failure) => write_failure(output, failure),
        },
        _ => write_failure(
            output,
            Failure::Protocol(
                "usage: sandbox-shim directory-backup <backup|restore> <request>".into(),
            ),
        ),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(request: &[u8]) -> Result<T, Failure> {
    serde_json::from_slice(request)
        .map_err(|error| Failure::Protocol(format!("invalid directory backup request: {error}")))
}

struct Session<'a, W: Write> {
    output: &'a mut W,
    lifeline: Lifeline,
    lock_path: &'a Path,
    lock: Option<File>,
}

impl<'a, W: Write> Session<'a, W> {
    fn run(
        input: impl Read + Send + 'static,
        output: &'a mut W,
        lock_path: &'a Path,
        work: impl FnOnce(&mut Self) -> Result<Value, Failure>,
    ) -> io::Result<()> {
        let lifeline = Lifeline::start(input);
        Self::with_lifeline(lifeline, output, lock_path, work)
    }

    fn with_lifeline(
        lifeline: Lifeline,
        output: &'a mut W,
        lock_path: &'a Path,
        work: impl FnOnce(&mut Self) -> Result<Value, Failure>,
    ) -> io::Result<()> {
        let mut session = Self {
            output,
            lifeline,
            lock_path,
            lock: None,
        };
        let result = work(&mut session);
        match result {
            Ok(mut value) => {
                value["kind"] = json!("done");
                protocol::write_data(session.output, value.to_string().as_bytes())?;
            }
            Err(Failure::Aborted) => return Ok(()),
            Err(failure) => write_failure(session.output, failure)?,
        }
        session.lifeline.wait_for_close();
        drop(session.lock.take());
        Ok(())
    }

    /// Waits for the container-wide lock, then for the package to register this operation's
    /// grant.
    fn lock(&mut self) -> Result<(), Failure> {
        if let Some(directory) = self.lock_path.parent() {
            fs::create_dir_all(directory)
                .map_err(|error| file_failure(error, directory.as_os_str().as_bytes()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.lock_path)
            .map_err(|error| file_failure(error, self.lock_path.as_os_str().as_bytes()))?;
        sys::lock_exclusive(&file)
            .map_err(|error| file_failure(error, self.lock_path.as_os_str().as_bytes()))?;
        self.lock = Some(file);
        protocol::write_data(self.output, br#"{"kind":"locked"}"#).map_err(|_| Failure::Aborted)?;
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
    let message = json!({ "kind": "error", "code": code, "detail": detail });
    protocol::write_data(output, message.to_string().as_bytes())
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
) -> Result<Value, Failure> {
    let root = absolute(&request.dir)?;
    let status = sys::lstatx(root.as_os_str())
        .map_err(|error| file_failure(error, root.as_os_str().as_bytes()))?;
    if status.file_type() != libc::S_IFDIR {
        return Err(Failure::File {
            errno: libc::ENOTDIR,
            detail: format!("{}: not a directory", root.display()),
        });
    }
    let selection = Selection::new(&root, &request.exclude, request.gitignore)?;
    session.lock()?;

    let lifeline = session.lifeline.clone();
    let gateway = Gateway::resolve(&request.gateway, lifeline.clone())?;
    let sink = PartSink::new(
        move |number, body| gateway.put_part(number, body),
        PART_SIZE,
        transfer::parallelism(),
    );
    let failures = sink.failures();
    let sink_failure = |error: io::Error| {
        if lifeline.aborted() {
            Failure::Aborted
        } else if let Some(failure) = failures.take() {
            failure
        } else {
            Failure::Transfer(format!("writing the archive failed: {error}"))
        }
    };
    let mut encoder =
        zstd::stream::write::Encoder::new(sink, COMPRESSION_LEVEL).map_err(sink_failure)?;
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    if cpus > 1 {
        encoder
            .multithread(u32::try_from(cpus).unwrap_or(u32::MAX))
            .map_err(sink_failure)?;
    }
    let aborted = || lifeline.aborted();
    let encoder = capture::capture(&root, &selection, encoder, &aborted, &sink_failure)?;
    let uploaded = encoder.finish().map_err(sink_failure)?.finish()?;
    Ok(json!({
        "size": uploaded.size,
        "sha256": uploaded.sha256,
        "parts": uploaded.parts,
    }))
}

fn restore<W: Write>(
    request: &RestoreRequest,
    session: &mut Session<'_, W>,
) -> Result<Value, Failure> {
    if request.size == 0
        || request.sha256.len() != 64
        || !request
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Failure::Protocol("invalid backup size or SHA-256".into()));
    }
    let target = absolute(&request.dir)?;
    let target_bytes = target.as_os_str().as_bytes();
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(Failure::File {
            errno: libc::EBUSY,
            detail: format!("{}: cannot restore over this path", target.display()),
        });
    };
    let parent_fd = sys::open_directory(parent.as_os_str())
        .map_err(|error| file_failure(error, parent.as_os_str().as_bytes()))?;
    let parent_status = sys::fstatx(parent_fd.as_raw_fd())
        .map_err(|error| file_failure(error, parent.as_os_str().as_bytes()))?;
    let name_c = sys::c_name(name.as_bytes()).map_err(|error| file_failure(error, target_bytes))?;
    let existing = match sys::statx_beneath(parent_fd.as_raw_fd(), &name_c) {
        Ok(status) => Some(status),
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => None,
        Err(error) => return Err(file_failure(error, target_bytes)),
    };
    if let Some(status) = existing {
        if status.file_type() != libc::S_IFDIR {
            return Err(Failure::File {
                errno: libc::ENOTDIR,
                detail: format!("{}: not a directory", target.display()),
            });
        }
        if status.mount != parent_status.mount {
            return Err(Failure::File {
                errno: libc::EBUSY,
                detail: format!("{}: is a mount point", target.display()),
            });
        }
    }
    session.lock()?;

    let tag = &transfer::hex(&Sha256::digest(name.as_bytes()))[..8];
    let sibling_prefix = format!("{SIBLING_PREFIX}{tag}-");
    sweep(parent, &sibling_prefix);
    let sibling_name = format!("{sibling_prefix}{}", random_hex()?);
    let sibling_c =
        sys::c_name(sibling_name.as_bytes()).map_err(|error| file_failure(error, target_bytes))?;
    let sibling_path = parent.join(&sibling_name);
    sys::mkdir_at(parent_fd.as_raw_fd(), &sibling_c, 0o700)
        .map_err(|error| file_failure(error, sibling_path.as_os_str().as_bytes()))?;
    // Removes the partial tree on failure, and the old tree after a swap.
    let _cleanup = RemoveOnDrop(sibling_path.clone());
    let sibling_fd = sys::open_directory_at(parent_fd.as_raw_fd(), &sibling_c)
        .map_err(|error| file_failure(error, sibling_path.as_os_str().as_bytes()))?;

    let lifeline = session.lifeline.clone();
    let gateway = Gateway::resolve(&request.gateway, lifeline.clone())?;
    let size = request.size;
    let ranges = RangeReader::new(
        move |offset, length| gateway.get_range(offset, length, size),
        size,
        PART_SIZE as u64,
        transfer::parallelism(),
    );
    let failures = ranges.failures();
    let read_failure = |error: io::Error| {
        if lifeline.aborted() {
            Failure::Aborted
        } else if let Some(failure) = failures.take() {
            failure
        } else {
            Failure::Integrity(format!("the backup is corrupt: {error}"))
        }
    };
    let aborted = || lifeline.aborted();
    let mut decoder = zstd::stream::read::Decoder::new(ranges).map_err(read_failure)?;
    let mut extractor = Extractor::new(sibling_fd, &aborted, &read_failure)?;
    extractor.extract(&mut decoder)?;

    // Only the tar format's end padding may follow the end marker.
    let trailing = io::copy(
        &mut (&mut decoder).take(MAX_TRAILING_BYTES + 1),
        &mut io::sink(),
    )
    .map_err(read_failure)?;
    if trailing > MAX_TRAILING_BYTES {
        return Err(Failure::Integrity("the archive has trailing data".into()));
    }
    let ranges = decoder.finish().into_inner();
    let (count, sha256) = ranges.digest();
    if !ranges.exhausted() || count != request.size || sha256 != request.sha256 {
        return Err(Failure::Integrity(
            "the backup's size or SHA-256 does not match its record".into(),
        ));
    }
    drop(ranges);
    extractor.finish()?;

    let swapped = if existing.is_some() {
        sys::exchange_at(parent_fd.as_raw_fd(), &sibling_c, &name_c)
    } else {
        sys::rename_noreplace_at(parent_fd.as_raw_fd(), &sibling_c, &name_c)
    };
    swapped.map_err(|error| file_failure(error, target_bytes))?;
    Ok(json!({}))
}

/// Removes what earlier restores into the same target left behind, without following symlinks.
fn sweep(parent: &Path, prefix: &str) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().as_bytes().starts_with(prefix.as_bytes()) {
            remove(&entry.path());
        }
    }
}

fn remove(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        remove(&self.0);
    }
}

fn random_hex() -> Result<String, Failure> {
    let mut bytes = [0u8; 8];
    // SAFETY: `bytes` is writable for its whole length.
    let count = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if count != bytes.len() as isize {
        return Err(file_failure(io::Error::last_os_error(), b"getrandom"));
    }
    Ok(transfer::hex(&bytes))
}
