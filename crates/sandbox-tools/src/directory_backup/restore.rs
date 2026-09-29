//! Restores a backup by extracting it into a new directory beside the target, checking that the
//! download is exactly the recorded backup, and swapping the new directory in with one rename
//! once the package confirms that the caller still wants it.

use std::ffi::{CStr, CString, OsStr};
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::extract::Extractor;
use super::lifeline::Lifeline;
use super::sys::{self, MountId};
use super::transfer::{self, Gateway, PART_SIZE, RangeReader};
use super::{Failure, Session, absolute, file_failure, hex};
use crate::mountinfo::{self, MountEntry};

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

/// Restores the backup. The download, its checks, and the directory metadata all come before
/// the `verified` frame. After the package's answer only the mount check, the rename, and
/// removing the replaced tree remain. The final frame carries nothing but its kind.
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
    download(request, &session.lifeline, sibling.open()?)?;
    session.request_swap()?;
    sibling.swap_in()
}

/// The directory a restore replaces, checked before the operation waits for the lock.
struct Target {
    path: PathBuf,
    parent: PathBuf,
    parent_fd: OwnedFd,
    /// The parent's mount, which removing a replaced tree never leaves.
    mount: MountId,
    name: CString,
    exists: bool,
}

impl Target {
    /// The target need not exist, but its parent must, and an existing target must be a
    /// directory with no mount at or inside it.
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
        if existing.is_some_and(|status| status.file_type() != libc::S_IFDIR) {
            return Err(Failure::File {
                errno: libc::ENOTDIR,
                detail: format!("{}: not a directory", path.display()),
            });
        }
        let target = Self {
            parent: parent.to_path_buf(),
            path,
            parent_fd,
            mount: parent_status.mount,
            name,
            exists: existing.is_some(),
        };
        target.refuse_mounts()?;
        Ok(target)
    }

    /// Refuses an existing target with a mount at or inside it. The exchange would carry a
    /// mount inside it into the replaced tree, out of the application's reach.
    fn refuse_mounts(&self) -> Result<(), Failure> {
        if !self.exists {
            return Ok(());
        }
        match self.mount_within(&self.name) {
            Ok(None) => Ok(()),
            Ok(Some(mount_point)) => Err(Failure::File {
                errno: libc::EBUSY,
                detail: format!(
                    "{}: has a mount at {}",
                    self.path.display(),
                    String::from_utf8_lossy(&mount_point)
                ),
            }),
            Err(error) => Err(file_failure(error, mountinfo::PATH.as_bytes())),
        }
    }

    /// The first mount that the mount table lists at or inside `name` in the parent.
    fn mount_within(&self, name: &CStr) -> io::Result<Option<Vec<u8>>> {
        // The parent's path as the mount table spells it, with symlinks resolved.
        let dir = fs::read_link(fd_path(&self.parent_fd))?.join(OsStr::from_bytes(name.to_bytes()));
        let entries = mountinfo::read(Path::new(mountinfo::PATH))?;
        Ok(find_mount_within(&entries, dir.as_os_str().as_bytes())
            .map(|entry| entry.mount_point.clone()))
    }

    /// Removes `name` in the parent, unless the mount table lists a mount at or inside it or
    /// cannot be read, and never enters another mount while removing. Without mount IDs a bind
    /// mount from the parent's filesystem looks like the parent's mount, so on kernels before
    /// 5.8 only the table protects it, and one made after the table is read can still be
    /// entered. Making one takes `CAP_SYS_ADMIN`.
    fn remove(&self, name: &CStr) {
        if matches!(self.mount_within(name), Ok(None)) {
            remove_at(self.parent_fd.as_raw_fd(), name, self.mount);
        }
    }
}

/// The first mount at `dir` or inside it.
fn find_mount_within<'a>(entries: &'a [MountEntry], dir: &[u8]) -> Option<&'a MountEntry> {
    entries.iter().find(|entry| {
        entry
            .mount_point
            .strip_prefix(dir)
            .is_some_and(|rest| rest.is_empty() || rest.first() == Some(&b'/'))
    })
}

/// A new, private directory beside the target that the restore extracts into. Dropping it
/// removes what it holds: the partial tree after a failure, or the replaced tree after a swap.
struct Sibling<'a> {
    target: &'a Target,
    path: PathBuf,
    name: CString,
}

impl<'a> Sibling<'a> {
    /// Removes what earlier restores into the same target left behind, then creates a sibling
    /// named after the target, so that the next restore finds it.
    fn create(target: &'a Target) -> Result<Self, Failure> {
        let tag = &hex(&Sha256::digest(target.name.as_bytes()))[..8];
        let prefix = format!("{SIBLING_PREFIX}{tag}-");
        sweep(target, &prefix);
        let name = format!("{prefix}{}", random_hex()?);
        let path = target.parent.join(&name);
        let failure = |error| file_failure(error, path.as_os_str().as_bytes());
        let name = sys::c_name(name.as_bytes()).map_err(failure)?;
        sys::mkdir_at(target.parent_fd.as_raw_fd(), &name, 0o700).map_err(failure)?;
        Ok(Self { target, path, name })
    }

    fn open(&self) -> Result<OwnedFd, Failure> {
        sys::open_directory_at(self.target.parent_fd.as_raw_fd(), &self.name)
            .map_err(|error| file_failure(error, self.path.as_os_str().as_bytes()))
    }

    /// Swaps the sibling in: an exchange when the target exists, which leaves the old tree
    /// here to be removed, or a rename that refuses to replace one created meanwhile. A mount
    /// made at or inside the target since it was inspected fails the restore instead.
    fn swap_in(self) -> Result<(), Failure> {
        let target = self.target;
        target.refuse_mounts()?;
        let parent = target.parent_fd.as_raw_fd();
        let swapped = if target.exists {
            sys::exchange_at(parent, &self.name, &target.name)
        } else {
            sys::rename_noreplace_at(parent, &self.name, &target.name)
        };
        swapped.map_err(|error| file_failure(error, target.path.as_os_str().as_bytes()))
    }
}

impl Drop for Sibling<'_> {
    fn drop(&mut self) {
        self.target.remove(&self.name);
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

/// Removes the leftovers of earlier restores into the same target.
fn sweep(target: &Target, prefix: &str) {
    let Ok(entries) = fs::read_dir(fd_path(&target.parent_fd)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.as_bytes().starts_with(prefix.as_bytes())
            && let Ok(name) = sys::c_name(name.as_bytes())
        {
            target.remove(&name);
        }
    }
}

/// Removes `name` in `parent` and everything beneath it that is on `mount`, without following
/// symlinks. It never enters another mount, whose files belong to whatever mounted it, so a
/// mount point and what it holds stay behind.
fn remove_at(parent: RawFd, name: &CStr, mount: MountId) {
    let dir = match sys::open_directory_at(parent, name) {
        Ok(dir) => dir,
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => {
            let _ = sys::unlink_at(parent, name, 0);
            return;
        }
        Err(_) => return,
    };
    if !sys::fstatx(dir.as_raw_fd()).is_ok_and(|status| status.mount == mount) {
        return;
    }
    if let Ok(entries) = fs::read_dir(fd_path(&dir)) {
        for entry in entries.flatten() {
            if let Ok(child) = sys::c_name(entry.file_name().as_bytes()) {
                remove_at(dir.as_raw_fd(), &child, mount);
            }
        }
    }
    drop(dir);
    let _ = sys::unlink_at(parent, name, libc::AT_REMOVEDIR);
}

/// The path that reopens `fd` itself, whatever its directory has since been renamed to.
fn fd_path(fd: &OwnedFd) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()))
}

fn random_hex() -> Result<String, Failure> {
    let mut bytes = [0u8; 8];
    // SAFETY: `bytes` is writable for its whole length.
    let count = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    if count != bytes.len() as isize {
        return Err(file_failure(io::Error::last_os_error(), b"getrandom"));
    }
    Ok(hex(&bytes))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::symlink;

    use super::{Target, find_mount_within, remove_at, sys};
    use crate::mountinfo::MountEntry;
    use crate::test_support::{TempDir, TestMount};

    fn remove_tree(temp: &TempDir) {
        let parent = sys::open_directory(temp.0.as_os_str()).unwrap();
        let mount = sys::fstatx(parent.as_raw_fd()).unwrap().mount;
        remove_at(parent.as_raw_fd(), c"tree", mount);
    }

    #[test]
    fn finds_mounts_at_or_inside_the_directory() {
        let entries: Vec<MountEntry> = ["/", "/workspace2/data", "/workspace/a/b"]
            .into_iter()
            .map(|point| MountEntry {
                mount_point: point.as_bytes().to_vec(),
                filesystem_type: "tmpfs".into(),
                source: "tmpfs".into(),
            })
            .collect();

        let within = |dir: &str| {
            find_mount_within(&entries, dir.as_bytes()).map(|entry| entry.mount_point.clone())
        };

        assert_eq!(within("/workspace"), Some(b"/workspace/a/b".to_vec()));
        assert_eq!(within("/workspace/a/b"), Some(b"/workspace/a/b".to_vec()));
        assert_eq!(within("/workspace/a/b/c"), None);
        assert_eq!(within("/srv"), None);
    }

    #[test]
    fn removing_a_tree_never_follows_symlinks() {
        let temp = TempDir::new();
        let tree = temp.0.join("tree");
        fs::create_dir_all(tree.join("nested")).unwrap();
        fs::write(tree.join("nested/file"), b"x").unwrap();
        fs::create_dir(temp.0.join("outside")).unwrap();
        fs::write(temp.0.join("outside/keep"), b"keep").unwrap();
        symlink(temp.0.join("outside"), tree.join("link")).unwrap();

        remove_tree(&temp);

        assert!(fs::symlink_metadata(&tree).is_err());
        assert_eq!(fs::read(temp.0.join("outside/keep")).unwrap(), b"keep");
    }

    #[test]
    fn removing_a_tree_never_enters_a_mount() {
        let temp = TempDir::new();
        let tree = temp.0.join("tree");
        fs::create_dir_all(tree.join("mnt")).unwrap();
        fs::write(tree.join("file"), b"x").unwrap();
        let Some(_mount) = TestMount::tmpfs(&tree.join("mnt")) else {
            return;
        };
        fs::write(tree.join("mnt/remote"), b"remote").unwrap();

        remove_tree(&temp);

        assert_eq!(fs::read(tree.join("mnt/remote")).unwrap(), b"remote");
        assert!(!tree.join("file").exists());
    }

    // Without mount IDs, a bind mount from the same filesystem has the parent's device number,
    // and only the mount table tells it apart.
    #[test]
    fn the_mount_table_finds_bind_mounts_from_the_same_filesystem() {
        for mount_point in ["tree", "tree/mnt"] {
            let temp = TempDir::new();
            fs::create_dir_all(temp.0.join("tree/mnt")).unwrap();
            fs::create_dir(temp.0.join("outside")).unwrap();
            let Some(_mount) = TestMount::bind(&temp.0.join("outside"), &temp.0.join(mount_point))
            else {
                return;
            };
            let target = Target::inspect(temp.0.join("new").to_str().unwrap()).unwrap();

            let found = target.mount_within(c"tree").unwrap().unwrap();

            assert!(found.ends_with(mount_point.as_bytes()), "{mount_point}");
        }
    }
}
