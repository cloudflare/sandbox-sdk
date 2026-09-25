//! The Linux calls that `std` does not expose: `statx` for mount IDs, `openat2` for
//! resolution that stays inside a directory, `renameat2` for the swap, inode flags, and `flock`.

use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};

const STATX_BASIC_STATS: u32 = 0x07ff;
const STATX_MNT_ID: u32 = 0x1000;
const RESOLVE_NO_XDEV: u64 = 0x01;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;
const RENAME_NOREPLACE: libc::c_uint = 1;
const RENAME_EXCHANGE: libc::c_uint = 2;
const FS_IOC_GETFLAGS: libc::c_ulong = 0x8008_6601;
const FS_IOC_SETFLAGS: libc::c_ulong = 0x4008_6602;
const FS_NOCOMP_FL: libc::c_int = 0x0000_0400;

/// Set once `openat2` turns out to be filtered, as older seccomp profiles do.
static OPENAT2_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

#[repr(C)]
#[derive(Clone, Copy)]
struct StatxTimestamp {
    tv_sec: i64,
    tv_nsec: u32,
    reserved: i32,
}

/// The kernel's `struct statx`, which is 256 bytes on every architecture.
#[repr(C)]
#[derive(Clone, Copy)]
struct RawStatx {
    mask: u32,
    blksize: u32,
    attributes: u64,
    nlink: u32,
    uid: u32,
    gid: u32,
    mode: u16,
    spare0: u16,
    ino: u64,
    size: u64,
    blocks: u64,
    attributes_mask: u64,
    atime: StatxTimestamp,
    btime: StatxTimestamp,
    ctime: StatxTimestamp,
    mtime: StatxTimestamp,
    rdev_major: u32,
    rdev_minor: u32,
    dev_major: u32,
    dev_minor: u32,
    mnt_id: u64,
    spare3: [u64; 13],
}

const _: () = assert!(std::mem::size_of::<RawStatx>() == 256);

/// What the walk needs to know about one path, read without following a final symlink.
#[derive(Clone, Copy, Debug)]
pub(super) struct Status {
    pub(super) mode: u32,
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) size: u64,
    pub(super) nlink: u32,
    pub(super) ino: u64,
    pub(super) mtime: (i64, u32),
    /// Device and, when the kernel reports it, mount ID. Two paths are on the same mount only
    /// when both match, which also catches bind mounts from the same device.
    pub(super) mount: (u32, u32, Option<u64>),
}

impl Status {
    pub(super) fn file_type(&self) -> u32 {
        self.mode & libc::S_IFMT
    }
}

pub(super) fn lstatx(path: &OsStr) -> io::Result<Status> {
    let path = c_path(path)?;
    statx_at(libc::AT_FDCWD, &path, libc::AT_SYMLINK_NOFOLLOW)
}

pub(super) fn fstatx(fd: RawFd) -> io::Result<Status> {
    statx_at(fd, c"", libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW)
}

pub(super) fn statx_beneath(dir: RawFd, name: &CStr) -> io::Result<Status> {
    statx_at(dir, name, libc::AT_SYMLINK_NOFOLLOW)
}

fn statx_at(dir: RawFd, path: &CStr, flags: libc::c_int) -> io::Result<Status> {
    let mut raw = std::mem::MaybeUninit::<RawStatx>::zeroed();
    // SAFETY: `raw` is a writable buffer of the size the kernel expects for `struct statx`.
    let result = unsafe {
        libc::syscall(
            libc::SYS_statx,
            dir,
            path.as_ptr(),
            flags,
            STATX_BASIC_STATS | STATX_MNT_ID,
            raw.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel filled the structure on success, and zero is valid for every field.
    let raw = unsafe { raw.assume_init() };
    Ok(Status {
        mode: u32::from(raw.mode),
        uid: raw.uid,
        gid: raw.gid,
        size: raw.size,
        nlink: raw.nlink,
        ino: raw.ino,
        mtime: (raw.mtime.tv_sec, raw.mtime.tv_nsec),
        mount: (
            raw.dev_major,
            raw.dev_minor,
            (raw.mask & STATX_MNT_ID != 0).then_some(raw.mnt_id),
        ),
    })
}

/// Opens `path` relative to `dir` without leaving `dir`, following any symlink, or crossing a
/// mount. `path` must be one or more normal names joined by `/`.
pub(super) fn open_beneath(dir: RawFd, path: &[u8], flags: libc::c_int) -> io::Result<OwnedFd> {
    if !OPENAT2_UNAVAILABLE.load(Ordering::Relaxed) {
        match openat2_beneath(dir, path, flags) {
            // Opening a directory never fails with EPERM; a seccomp filter does.
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EPERM)) => {
                OPENAT2_UNAVAILABLE.store(true, Ordering::Relaxed);
            }
            result => return result,
        }
    }
    walk_beneath(dir, path, flags)
}

fn openat2_beneath(dir: RawFd, path: &[u8], flags: libc::c_int) -> io::Result<OwnedFd> {
    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    let path = CString::new(path).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
    };
    // SAFETY: `how` is a valid `struct open_how` and its size is passed alongside it.
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dir,
            path.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    };
    owned(fd)
}

/// `open_beneath` without `openat2`: opens one name at a time and refuses every symlink. Normal
/// names cannot climb out of `dir`. It does not refuse mount points, which the restore's fresh
/// directory does not contain.
fn walk_beneath(dir: RawFd, path: &[u8], flags: libc::c_int) -> io::Result<OwnedFd> {
    let mut names = path.split(|byte| *byte == b'/').peekable();
    let mut current: Option<OwnedFd> = None;
    while let Some(name) = names.next() {
        if name.is_empty() || name == b"." || name == b".." {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        let name = CString::new(name).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
        let step_flags = if names.peek().is_none() {
            flags
        } else {
            libc::O_PATH | libc::O_DIRECTORY
        };
        let base = current.as_ref().map_or(dir, AsRawFd::as_raw_fd);
        // SAFETY: `name` is NUL-terminated.
        let fd = unsafe {
            libc::openat(
                base,
                name.as_ptr(),
                step_flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        current = Some(owned(fd.into())?);
    }
    current.ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))
}

/// Opens a directory by path, following symlinks anywhere in it.
pub(super) fn open_directory(path: &OsStr) -> io::Result<OwnedFd> {
    let path = c_path(path)?;
    // SAFETY: `path` is NUL-terminated.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    owned(fd.into())
}

pub(super) fn open_directory_at(dir: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    // SAFETY: `name` is NUL-terminated.
    let fd = unsafe {
        libc::openat(
            dir,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    owned(fd.into())
}

pub(super) fn create_file_at(dir: RawFd, name: &CStr) -> io::Result<File> {
    // SAFETY: `name` is NUL-terminated.
    let fd = unsafe {
        libc::openat(
            dir,
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    owned(fd.into()).map(File::from)
}

pub(super) fn mkdir_at(dir: RawFd, name: &CStr, mode: libc::mode_t) -> io::Result<()> {
    // SAFETY: `name` is NUL-terminated.
    check(unsafe { libc::mkdirat(dir, name.as_ptr(), mode) })
}

pub(super) fn symlink_at(target: &[u8], dir: RawFd, name: &CStr) -> io::Result<()> {
    let target = CString::new(target).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    // SAFETY: both strings are NUL-terminated.
    check(unsafe { libc::symlinkat(target.as_ptr(), dir, name.as_ptr()) })
}

pub(super) fn link_at(
    source_dir: RawFd,
    source: &CStr,
    target_dir: RawFd,
    target: &CStr,
) -> io::Result<()> {
    // SAFETY: both names are NUL-terminated. Flags 0 never follows a symlink source.
    check(unsafe { libc::linkat(source_dir, source.as_ptr(), target_dir, target.as_ptr(), 0) })
}

pub(super) fn chown_fd(fd: RawFd, uid: u32, gid: u32) -> io::Result<()> {
    // SAFETY: plain syscall on a caller-owned descriptor.
    check(unsafe { libc::fchown(fd, uid, gid) })
}

pub(super) fn chown_at(dir: RawFd, name: &CStr, uid: u32, gid: u32) -> io::Result<()> {
    // SAFETY: `name` is NUL-terminated.
    check(unsafe { libc::fchownat(dir, name.as_ptr(), uid, gid, libc::AT_SYMLINK_NOFOLLOW) })
}

pub(super) fn chmod_fd(fd: RawFd, mode: u32) -> io::Result<()> {
    // SAFETY: plain syscall on a caller-owned descriptor.
    check(unsafe { libc::fchmod(fd, mode as libc::mode_t) })
}

pub(super) fn set_mtime_fd(fd: RawFd, mtime: (i64, u32)) -> io::Result<()> {
    let times = times(mtime);
    // SAFETY: `times` holds two valid timespecs.
    check(unsafe { libc::futimens(fd, times.as_ptr()) })
}

pub(super) fn set_mtime_at(dir: RawFd, name: &CStr, mtime: (i64, u32)) -> io::Result<()> {
    let times = times(mtime);
    // SAFETY: `name` is NUL-terminated and `times` holds two valid timespecs.
    check(unsafe {
        libc::utimensat(
            dir,
            name.as_ptr(),
            times.as_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    })
}

fn times(mtime: (i64, u32)) -> [libc::timespec; 2] {
    [
        libc::timespec {
            tv_sec: 0,
            tv_nsec: libc::UTIME_OMIT,
        },
        libc::timespec {
            tv_sec: mtime.0 as _,
            tv_nsec: libc::c_long::from(mtime.1 as i32),
        },
    ]
}

/// Swaps two names in one directory. Both must exist.
pub(super) fn exchange_at(dir: RawFd, first: &CStr, second: &CStr) -> io::Result<()> {
    renameat2(dir, first, second, RENAME_EXCHANGE)
}

/// Renames `source` to `target`, failing with `EEXIST` rather than replacing `target`.
pub(super) fn rename_noreplace_at(dir: RawFd, source: &CStr, target: &CStr) -> io::Result<()> {
    renameat2(dir, source, target, RENAME_NOREPLACE)
}

fn renameat2(dir: RawFd, from: &CStr, to: &CStr, flags: libc::c_uint) -> io::Result<()> {
    // SAFETY: both names are NUL-terminated and relative to the same open directory.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            dir,
            from.as_ptr(),
            dir,
            to.as_ptr(),
            flags,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Sets or clears btrfs's "don't compress" inode flag. Filesystems without the flag report
/// an error, which callers ignore: the flag only changes speed and disk use.
pub(super) fn set_no_compress(fd: RawFd, enabled: bool) -> io::Result<()> {
    // The kernel reads and writes an int here, whatever the ioctl number's declared size says.
    let mut flags: libc::c_int = 0;
    // SAFETY: FS_IOC_GETFLAGS writes one int through the pointer.
    check(unsafe { libc::ioctl(fd, FS_IOC_GETFLAGS as _, &mut flags) })?;
    let updated = if enabled {
        flags | FS_NOCOMP_FL
    } else {
        flags & !FS_NOCOMP_FL
    };
    if updated == flags {
        return Ok(());
    }
    // SAFETY: FS_IOC_SETFLAGS reads one int through the pointer.
    check(unsafe { libc::ioctl(fd, FS_IOC_SETFLAGS as _, &updated) })
}

/// Bytes available to unprivileged writers, and the filesystem's total size.
pub(super) fn free_space(fd: RawFd) -> io::Result<(u64, u64)> {
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: `stat` is a writable `struct statvfs`.
    check(unsafe { libc::fstatvfs(fd, stat.as_mut_ptr()) })?;
    // SAFETY: filled on success.
    let stat = unsafe { stat.assume_init() };
    let unit = stat.f_frsize;
    Ok((
        stat.f_bavail.saturating_mul(unit),
        stat.f_blocks.saturating_mul(unit),
    ))
}

/// Blocks until this process holds an exclusive lock on `file`.
pub(super) fn lock_exclusive(file: &File) -> io::Result<()> {
    loop {
        // SAFETY: plain syscall on an open descriptor.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub(super) fn is_root() -> bool {
    // SAFETY: geteuid cannot fail.
    unsafe { libc::geteuid() == 0 }
}

pub(super) fn c_name(name: &[u8]) -> io::Result<CString> {
    CString::new(name).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

fn c_path(path: &OsStr) -> io::Result<CString> {
    c_name(path.as_bytes())
}

fn owned(fd: libc::c_long) -> io::Result<OwnedFd> {
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel returned a new descriptor that nothing else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
}

fn check(result: libc::c_int) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::symlink;

    use super::{open_directory, walk_beneath};
    use crate::test_support::TempDir;

    // `openat2` is available wherever these tests usually run, so exercise the fallback directly.
    #[test]
    fn the_openat2_fallback_refuses_symlinks_and_climbing() {
        let root = TempDir::new();
        fs::create_dir_all(root.0.join("a/b")).unwrap();
        symlink("/", root.0.join("a/escape")).unwrap();
        symlink("b", root.0.join("a/inside")).unwrap();
        let fd = open_directory(root.0.as_os_str()).unwrap();
        let errno = |path: &[u8]| {
            walk_beneath(fd.as_raw_fd(), path, libc::O_PATH | libc::O_DIRECTORY)
                .unwrap_err()
                .raw_os_error()
        };

        walk_beneath(fd.as_raw_fd(), b"a/b", libc::O_PATH | libc::O_DIRECTORY).unwrap();
        assert!(matches!(
            errno(b"a/escape/etc"),
            Some(libc::ENOTDIR | libc::ELOOP)
        ));
        assert!(matches!(
            errno(b"a/escape"),
            Some(libc::ENOTDIR | libc::ELOOP)
        ));
        assert!(matches!(
            errno(b"a/inside"),
            Some(libc::ENOTDIR | libc::ELOOP)
        ));
        assert_eq!(errno(b"a/../.."), Some(libc::EXDEV));
        assert_eq!(errno(b"a/missing"), Some(libc::ENOENT));
    }
}
