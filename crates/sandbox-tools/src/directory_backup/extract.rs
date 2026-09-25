//! Extracts a backup's tar stream into a new, private directory. Every path is resolved
//! relative to that directory's descriptor with `openat2`, so no entry can reach outside it,
//! through a symlink, or across a mount, whatever the archive contains.

use std::ffi::CString;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use super::sys;
use super::{Failure, file_failure};

const MAX_PAX_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: u64 = 50_000_000;
const COPY_BUFFER: usize = 256 * 1024;
const FLOOR_CHECK_BYTES: u64 = 8 * 1024 * 1024;
const FLOOR_CHECK_ENTRIES: u64 = 1024;
const MAX_FLOOR: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
struct Metadata {
    mode: u32,
    uid: u32,
    gid: u32,
    mtime: (i64, u32),
}

/// Extraction state for one restore.
pub(super) struct Extractor<'a> {
    root: OwnedFd,
    /// The parent directory of the last entry, which is usually the next entry's parent too.
    parent: Option<(Vec<u8>, OwnedFd)>,
    directories: Vec<(Vec<u8>, Metadata)>,
    root_metadata: Option<Metadata>,
    as_root: bool,
    no_compress: bool,
    floor: u64,
    unchecked_bytes: u64,
    unchecked_entries: u64,
    entries: u64,
    aborted: &'a dyn Fn() -> bool,
    read_failure: &'a dyn Fn(io::Error) -> Failure,
}

impl<'a> Extractor<'a> {
    /// `root` is the new, empty directory, opened for reading. `read_failure` explains an error
    /// reading the archive.
    pub(super) fn new(
        root: OwnedFd,
        aborted: &'a dyn Fn() -> bool,
        read_failure: &'a dyn Fn(io::Error) -> Failure,
    ) -> Result<Self, Failure> {
        let (_, total) = sys::free_space(root.as_raw_fd())
            .map_err(|error| file_failure(error, b"restore directory"))?;
        // Extraction is much faster without btrfs compression. Other filesystems refuse the flag,
        // which changes nothing.
        let no_compress = sys::set_no_compress(root.as_raw_fd(), true).is_ok();
        Ok(Self {
            root,
            parent: None,
            directories: Vec::new(),
            root_metadata: None,
            as_root: sys::is_root(),
            no_compress,
            floor: (total / 20).min(MAX_FLOOR),
            unchecked_bytes: 0,
            unchecked_entries: 0,
            entries: 0,
            aborted,
            read_failure,
        })
    }

    /// Extracts every entry until the archive's end marker, leaving the rest of `input` unread.
    pub(super) fn extract(&mut self, input: &mut impl Read) -> Result<(), Failure> {
        let mut archive = tar::Archive::new(input);
        let entries = archive.entries().map_err(self.read_failure)?.raw(true);
        let mut pending = Pending::default();
        for entry in entries {
            let mut entry = entry.map_err(self.read_failure)?;
            if (self.aborted)() {
                return Err(Failure::Aborted);
            }
            self.entries += 1;
            if self.entries > MAX_ENTRIES {
                return Err(Failure::Integrity(
                    "the archive has too many entries".into(),
                ));
            }
            let entry_type = entry.header().entry_type();
            if entry_type.is_pax_local_extensions() {
                if entry.size() > MAX_PAX_BYTES {
                    return Err(Failure::Integrity("a PAX header is too large".into()));
                }
                let mut records = Vec::new();
                entry.read_to_end(&mut records).map_err(self.read_failure)?;
                pending = Pending::parse(&records)?;
                continue;
            }
            let extensions = std::mem::take(&mut pending);
            if entry_type.is_pax_global_extensions()
                || entry_type.is_gnu_longname()
                || entry_type.is_gnu_longlink()
            {
                continue;
            }
            let header = entry.header();
            let path = extensions
                .path
                .unwrap_or_else(|| entry.path_bytes().into_owned());
            let link = extensions
                .linkpath
                .or_else(|| entry.link_name_bytes().map(|link| link.into_owned()));
            let metadata = Metadata {
                // setuid and setgid are never restored.
                mode: header.mode().map_err(self.read_failure)? & 0o1777,
                uid: u32::try_from(header.uid().map_err(self.read_failure)?).unwrap_or(u32::MAX),
                gid: u32::try_from(header.gid().map_err(self.read_failure)?).unwrap_or(u32::MAX),
                mtime: match extensions.mtime {
                    Some(mtime) => mtime,
                    None => (header.mtime().map_err(self.read_failure)? as i64, 0),
                },
            };
            let entry_path = components(&path)?;
            match entry_type {
                tar::EntryType::Directory => self.directory(&entry_path, metadata)?,
                tar::EntryType::Regular | tar::EntryType::Continuous => {
                    let size = entry.size();
                    self.file(&entry_path, metadata, &mut entry, size)?;
                }
                tar::EntryType::Symlink => {
                    let target =
                        link.ok_or_else(|| Failure::Integrity("a symlink has no target".into()))?;
                    self.symlink(&entry_path, &target, metadata)?;
                }
                tar::EntryType::Link => {
                    let target =
                        link.ok_or_else(|| Failure::Integrity("a hard link has no target".into()))?;
                    self.hard_link(&entry_path, &components(&target)?)?;
                }
                // Devices, FIFOs, and anything else are never created.
                _ => {}
            }
            self.check_floor()?;
        }
        Ok(())
    }

    fn directory(&mut self, path: &[&[u8]], metadata: Metadata) -> Result<(), Failure> {
        let Some((name, parents)) = path.split_last() else {
            self.root_metadata = Some(metadata);
            return Ok(());
        };
        let parent = self.parent(parents)?;
        let name = c_name(name)?;
        match sys::mkdir_at(parent, &name, 0o700) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
                let existing = sys::statx_beneath(parent, &name)
                    .map_err(|error| self.write_failure(error, path))?;
                if existing.file_type() != libc::S_IFDIR {
                    return Err(duplicate(path));
                }
            }
            Err(error) => return Err(self.write_failure(error, path)),
        }
        self.directories.push((path.join(&b'/'), metadata));
        Ok(())
    }

    fn file(
        &mut self,
        path: &[&[u8]],
        metadata: Metadata,
        data: &mut impl Read,
        size: u64,
    ) -> Result<(), Failure> {
        let (name, parents) = path.split_last().ok_or_else(root_not_directory)?;
        let parent = self.parent(parents)?;
        let mut file = match sys::create_file_at(parent, &c_name(name)?) {
            Ok(file) => file,
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
                return Err(duplicate(path));
            }
            Err(error) => return Err(self.write_failure(error, path)),
        };
        let mut buffer = vec![0u8; COPY_BUFFER.min(size.max(1) as usize)];
        let mut remaining = size;
        while remaining > 0 {
            let limit = buffer.len().min(remaining as usize);
            let count = data.read(&mut buffer[..limit]).map_err(self.read_failure)?;
            if count == 0 {
                return Err((self.read_failure)(io::ErrorKind::UnexpectedEof.into()));
            }
            file.write_all(&buffer[..count])
                .map_err(|error| self.write_failure(error, path))?;
            remaining -= count as u64;
            self.unchecked_bytes += count as u64;
            if self.unchecked_bytes >= FLOOR_CHECK_BYTES {
                self.check_floor()?;
                if (self.aborted)() {
                    return Err(Failure::Aborted);
                }
            }
        }
        let fd = file.as_raw_fd();
        if self.as_root {
            // Numeric IDs are kept even when the image has no such user. A user namespace
            // that can't map an ID leaves the file owned by root.
            let _ = sys::chown_fd(fd, metadata.uid, metadata.gid);
        }
        sys::chmod_fd(fd, metadata.mode).map_err(|error| self.write_failure(error, path))?;
        sys::set_mtime_fd(fd, metadata.mtime).map_err(|error| self.write_failure(error, path))?;
        Ok(())
    }

    fn symlink(
        &mut self,
        path: &[&[u8]],
        target: &[u8],
        metadata: Metadata,
    ) -> Result<(), Failure> {
        let (name, parents) = path.split_last().ok_or_else(root_not_directory)?;
        let parent = self.parent(parents)?;
        let name = c_name(name)?;
        match sys::symlink_at(target, parent, &name) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
                return Err(duplicate(path));
            }
            Err(error) => return Err(self.write_failure(error, path)),
        }
        if self.as_root {
            let _ = sys::chown_at(parent, &name, metadata.uid, metadata.gid);
        }
        sys::set_mtime_at(parent, &name, metadata.mtime)
            .map_err(|error| self.write_failure(error, path))
    }

    fn hard_link(&mut self, path: &[&[u8]], target: &[&[u8]]) -> Result<(), Failure> {
        let (target_name, target_parents) = target
            .split_last()
            .ok_or_else(|| Failure::Integrity("a hard link points at the root".into()))?;
        let target_parent = self.open_directory(target_parents, libc::O_PATH)?;
        let target_name = c_name(target_name)?;
        let target_parent_fd = target_parent
            .as_ref()
            .map_or(self.root.as_raw_fd(), AsRawFd::as_raw_fd);
        let existing = sys::statx_beneath(target_parent_fd, &target_name).map_err(|error| {
            if error.raw_os_error() == Some(libc::ENOENT) {
                Failure::Integrity("a hard link points at an entry not yet extracted".into())
            } else {
                self.write_failure(error, target)
            }
        })?;
        if existing.file_type() != libc::S_IFREG {
            return Err(Failure::Integrity(
                "a hard link points at something other than a file".into(),
            ));
        }
        let (name, parents) = path.split_last().ok_or_else(root_not_directory)?;
        let parent = self.parent(parents)?;
        match sys::link_at(target_parent_fd, &target_name, parent, &c_name(name)?) {
            Ok(()) => Ok(()),
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => Err(duplicate(path)),
            Err(error) => Err(self.write_failure(error, path)),
        }
    }

    /// Returns a descriptor for the directory holding an entry, reusing the last one.
    fn parent(&mut self, parents: &[&[u8]]) -> Result<RawFd, Failure> {
        if parents.is_empty() {
            return Ok(self.root.as_raw_fd());
        }
        let joined = parents.join(&b'/');
        let cached = self
            .parent
            .as_ref()
            .is_some_and(|(path, _)| *path == joined);
        if !cached {
            let fd = self
                .open_directory(parents, libc::O_PATH)?
                .expect("parents is not empty");
            self.parent = Some((joined, fd));
        }
        Ok(self
            .parent
            .as_ref()
            .map(|(_, fd)| fd.as_raw_fd())
            .expect("the parent was just cached"))
    }

    /// Opens a directory inside the root, or returns `None` for the root itself.
    fn open_directory(
        &self,
        path: &[&[u8]],
        flags: libc::c_int,
    ) -> Result<Option<OwnedFd>, Failure> {
        if path.is_empty() {
            return Ok(None);
        }
        sys::open_beneath(
            self.root.as_raw_fd(),
            &path.join(&b'/'),
            flags | libc::O_DIRECTORY,
        )
        .map(Some)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ENOENT) => {
                Failure::Integrity("an entry appears before its directory".into())
            }
            Some(libc::ELOOP | libc::EXDEV | libc::ENOTDIR | libc::EAGAIN) => {
                Failure::Integrity("an entry's path leaves its directory".into())
            }
            _ => self.write_failure(error, path),
        })
    }

    /// Stops before the restore takes the filesystem below 5% free, or 256 MiB, whichever is
    /// smaller, so other processes in the sandbox keep working.
    fn check_floor(&mut self) -> Result<(), Failure> {
        self.unchecked_entries += 1;
        if self.unchecked_bytes < FLOOR_CHECK_BYTES && self.unchecked_entries < FLOOR_CHECK_ENTRIES
        {
            return Ok(());
        }
        self.unchecked_bytes = 0;
        self.unchecked_entries = 0;
        let (available, _) = sys::free_space(self.root.as_raw_fd())
            .map_err(|error| file_failure(error, b"restore directory"))?;
        if available < self.floor {
            return Err(Failure::File {
                errno: libc::ENOSPC,
                detail: format!(
                    "restore stopped with {available} bytes free, below the {} byte floor",
                    self.floor
                ),
            });
        }
        Ok(())
    }

    /// Applies directory metadata, deepest first, and the root's last. Clears the extraction's
    /// no-compression flag from every directory, so files written later compress as usual.
    pub(super) fn finish(mut self) -> Result<(), Failure> {
        let root_metadata = self
            .root_metadata
            .ok_or_else(|| Failure::Integrity("the archive has no root directory entry".into()))?;
        self.parent = None;
        let mut directories = std::mem::take(&mut self.directories);
        directories.sort_by_key(|(path, _)| std::cmp::Reverse(path.split(|b| *b == b'/').count()));
        for (path, metadata) in &directories {
            let components: Vec<&[u8]> = path.split(|byte| *byte == b'/').collect();
            let fd = self
                .open_directory(&components, libc::O_RDONLY)?
                .expect("a directory entry below the root has a name");
            self.apply(fd.as_raw_fd(), *metadata, &components)?;
        }
        let root = self.root.as_raw_fd();
        self.apply(root, root_metadata, &[])
    }

    fn apply(&self, fd: RawFd, metadata: Metadata, path: &[&[u8]]) -> Result<(), Failure> {
        if self.no_compress {
            let _ = sys::set_no_compress(fd, false);
        }
        if self.as_root {
            let _ = sys::chown_fd(fd, metadata.uid, metadata.gid);
        }
        sys::chmod_fd(fd, metadata.mode).map_err(|error| self.write_failure(error, path))?;
        sys::set_mtime_fd(fd, metadata.mtime).map_err(|error| self.write_failure(error, path))
    }

    fn write_failure(&self, error: io::Error, path: &[&[u8]]) -> Failure {
        file_failure(error, &path.join(&b'/'))
    }
}

/// Extended header fields that apply to the next entry.
#[derive(Default)]
struct Pending {
    path: Option<Vec<u8>>,
    linkpath: Option<Vec<u8>>,
    mtime: Option<(i64, u32)>,
}

impl Pending {
    fn parse(mut records: &[u8]) -> Result<Self, Failure> {
        let invalid = || Failure::Integrity("a PAX header is malformed".into());
        let mut pending = Self::default();
        while !records.is_empty() {
            let space = records
                .iter()
                .position(|byte| *byte == b' ')
                .ok_or_else(invalid)?;
            let length: usize = std::str::from_utf8(&records[..space])
                .ok()
                .and_then(|length| length.parse().ok())
                .ok_or_else(invalid)?;
            if length <= space + 1 || length > records.len() || records[length - 1] != b'\n' {
                return Err(invalid());
            }
            let record = &records[space + 1..length - 1];
            let equals = record
                .iter()
                .position(|byte| *byte == b'=')
                .ok_or_else(invalid)?;
            let (key, value) = (&record[..equals], &record[equals + 1..]);
            match key {
                b"path" => pending.path = Some(value.to_vec()),
                b"linkpath" => pending.linkpath = Some(value.to_vec()),
                b"mtime" => pending.mtime = Some(parse_time(value).ok_or_else(invalid)?),
                _ => {}
            }
            records = &records[length..];
        }
        Ok(pending)
    }
}

fn parse_time(value: &[u8]) -> Option<(i64, u32)> {
    let text = std::str::from_utf8(value).ok()?;
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let whole: i64 = whole.parse().ok()?;
    if !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let digits = &fraction[..fraction.len().min(9)];
    let nanoseconds: u32 = format!("{digits:0<9}").parse().ok()?;
    Some(match (negative, nanoseconds) {
        (false, _) => (whole, nanoseconds),
        (true, 0) => (-whole, 0),
        (true, _) => (-whole - 1, 1_000_000_000 - nanoseconds),
    })
}

/// Splits an entry path into components, rejecting anything that could leave the root.
fn components(path: &[u8]) -> Result<Vec<&[u8]>, Failure> {
    if path.first() == Some(&b'/') {
        return Err(Failure::Integrity("an entry has an absolute path".into()));
    }
    let mut components = Vec::new();
    for component in path.split(|byte| *byte == b'/') {
        match component {
            b"" | b"." => {}
            b".." => return Err(Failure::Integrity("an entry's path contains '..'".into())),
            _ => components.push(component),
        }
    }
    Ok(components)
}

fn c_name(name: &[u8]) -> Result<CString, Failure> {
    sys::c_name(name).map_err(|_| Failure::Integrity("an entry name contains NUL".into()))
}

fn duplicate(path: &[&[u8]]) -> Failure {
    Failure::Integrity(format!(
        "the archive has two entries for '{}'",
        String::from_utf8_lossy(&path.join(&b'/'))
    ))
}

fn root_not_directory() -> Failure {
    Failure::Integrity("the archive's root is not a directory".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_signed_pax_times() {
        assert_eq!(parse_time(b"12.000000005"), Some((12, 5)));
        assert_eq!(parse_time(b"12.5"), Some((12, 500_000_000)));
        assert_eq!(parse_time(b"12"), Some((12, 0)));
        assert_eq!(parse_time(b"-1.5"), Some((-2, 500_000_000)));
        assert_eq!(parse_time(b"-1"), Some((-1, 0)));
        assert_eq!(parse_time(b"1.x"), None);
    }

    #[test]
    fn rejects_paths_that_leave_the_root() {
        assert!(components(b"/etc/passwd").is_err());
        assert!(components(b"a/../../etc").is_err());
        assert_eq!(components(b"./a//b/").unwrap(), vec![&b"a"[..], b"b"]);
        assert!(components(b"./").unwrap().is_empty());
    }

    #[test]
    fn parses_pax_records() {
        let pending = Pending::parse(b"14 path=a/b/c\n30 mtime=1700000000.000000001\n").unwrap();
        assert_eq!(pending.path.as_deref(), Some(&b"a/b/c"[..]));
        assert_eq!(pending.mtime, Some((1_700_000_000, 1)));
        assert!(Pending::parse(b"99 path=x\n").is_err());
    }
}
