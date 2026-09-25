//! Restores a backup by extracting it into a new directory beside the target, checking that the
//! download is exactly the recorded backup, and swapping the new directory in with one rename.

use std::ffi::CString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::extract::Extractor;
use super::lifeline::Lifeline;
use super::transfer::{self, Gateway, PART_SIZE, RangeReader};
use super::{Failure, Session, absolute, file_failure, sys};

const SIBLING_PREFIX: &str = ".sandbox-restore-";
const MAX_TRAILING_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RestoreRequest {
    gateway: String,
    dir: String,
    size: u64,
    sha256: String,
}

pub(super) fn restore<W: Write>(
    request: &RestoreRequest,
    session: &mut Session<'_, W>,
) -> Result<(), Failure> {
    let is_sha256 = request.sha256.len() == 64
        && request
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if request.size == 0 || !is_sha256 {
        return Err(Failure::Protocol("invalid backup size or SHA-256".into()));
    }
    let target = Target::inspect(&request.dir)?;
    session.lock()?;
    let sibling = Sibling::create(&target)?;
    download(request, &session.lifeline, sibling.open(&target)?)?;
    sibling.swap_into(&target)
}

/// The directory a restore replaces, checked before the operation waits for the lock.
struct Target {
    path: PathBuf,
    parent: PathBuf,
    parent_fd: OwnedFd,
    name: CString,
    exists: bool,
}

impl Target {
    /// The target need not exist, but its parent must, and an existing target must be a
    /// directory on the parent's mount.
    fn inspect(dir: &str) -> Result<Self, Failure> {
        let path = absolute(dir)?;
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err(Failure::File {
                errno: libc::EBUSY,
                detail: format!("{}: cannot restore over this path", path.display()),
            });
        };
        let parent_failure = |error| file_failure(error, parent.as_os_str().as_bytes());
        let parent_fd = sys::open_directory(parent.as_os_str()).map_err(parent_failure)?;
        let parent_status = sys::fstatx(parent_fd.as_raw_fd()).map_err(parent_failure)?;
        let target_failure = |error| file_failure(error, path.as_os_str().as_bytes());
        let name = sys::c_name(name.as_bytes()).map_err(target_failure)?;
        let existing = match sys::statx_beneath(parent_fd.as_raw_fd(), &name) {
            Ok(status) => Some(status),
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => None,
            Err(error) => return Err(target_failure(error)),
        };
        if let Some(status) = &existing {
            if status.file_type() != libc::S_IFDIR {
                return Err(Failure::File {
                    errno: libc::ENOTDIR,
                    detail: format!("{}: not a directory", path.display()),
                });
            }
            if status.mount != parent_status.mount {
                return Err(Failure::File {
                    errno: libc::EBUSY,
                    detail: format!("{}: is a mount point", path.display()),
                });
            }
        }
        Ok(Self {
            parent: parent.to_path_buf(),
            path,
            parent_fd,
            name,
            exists: existing.is_some(),
        })
    }
}

/// A new, private directory beside the target that the restore extracts into. Dropping it
/// removes what it holds: the partial tree after a failure, or the replaced tree after a swap.
struct Sibling {
    path: PathBuf,
    name: CString,
}

impl Sibling {
    /// Removes what earlier restores into the same target left behind, then creates a sibling
    /// named after the target, so that the next restore finds it.
    fn create(target: &Target) -> Result<Self, Failure> {
        let tag = &transfer::hex(&Sha256::digest(target.name.as_bytes()))[..8];
        let prefix = format!("{SIBLING_PREFIX}{tag}-");
        sweep(&target.parent, &prefix);
        let name = format!("{prefix}{}", random_hex()?);
        let path = target.parent.join(&name);
        let failure = |error| file_failure(error, path.as_os_str().as_bytes());
        let name = sys::c_name(name.as_bytes()).map_err(failure)?;
        sys::mkdir_at(target.parent_fd.as_raw_fd(), &name, 0o700).map_err(failure)?;
        Ok(Self { path, name })
    }

    fn open(&self, target: &Target) -> Result<OwnedFd, Failure> {
        sys::open_directory_at(target.parent_fd.as_raw_fd(), &self.name)
            .map_err(|error| file_failure(error, self.path.as_os_str().as_bytes()))
    }

    /// Swaps the sibling in: an exchange when the target exists, which leaves the old tree
    /// here to be removed, or a rename that refuses to replace one created meanwhile.
    fn swap_into(self, target: &Target) -> Result<(), Failure> {
        let parent = target.parent_fd.as_raw_fd();
        let swapped = if target.exists {
            sys::exchange_at(parent, &self.name, &target.name)
        } else {
            sys::rename_noreplace_at(parent, &self.name, &target.name)
        };
        swapped.map_err(|error| file_failure(error, target.path.as_os_str().as_bytes()))
    }
}

impl Drop for Sibling {
    fn drop(&mut self) {
        remove(&self.path);
    }
}

/// Streams the object into `root`, then checks that it is exactly the recorded backup.
fn download(request: &RestoreRequest, lifeline: &Lifeline, root: OwnedFd) -> Result<(), Failure> {
    let gateway = Gateway::resolve(&request.gateway, lifeline.clone())?;
    let size = request.size;
    let ranges = RangeReader::new(
        move |offset, length| gateway.get_range(offset, length, size),
        size,
        PART_SIZE as u64,
        transfer::parallelism(),
    );
    let aborted = || lifeline.aborted();
    let mut decoder = zstd::stream::read::Decoder::new(ranges).map_err(Failure::reading)?;
    let mut extractor = Extractor::new(root, &aborted)?;
    extractor.extract(&mut decoder)?;

    // Only the tar format's end padding may follow the end marker.
    let trailing = io::copy(
        &mut (&mut decoder).take(MAX_TRAILING_BYTES + 1),
        &mut io::sink(),
    )
    .map_err(Failure::reading)?;
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
    extractor.finish()
}

/// Removes the leftovers of earlier restores, without following symlinks.
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

fn random_hex() -> Result<String, Failure> {
    let mut bytes = [0u8; 8];
    // SAFETY: `bytes` is writable for its whole length.
    let count = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if count != bytes.len() as isize {
        return Err(file_failure(io::Error::last_os_error(), b"getrandom"));
    }
    Ok(transfer::hex(&bytes))
}
