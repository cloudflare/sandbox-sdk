//! Writes one directory as a PAX tar stream: the live tree, without following symlinks or
//! crossing mounts, filtered by gitignore-style patterns.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use super::sys::{self, Status};
use super::{Failure, file_failure};

/// Which paths under the directory to leave out.
pub(super) struct Selection {
    exclude: Gitignore,
    gitignore: bool,
    info_exclude: Option<Gitignore>,
}

impl Selection {
    pub(super) fn new(root: &Path, exclude: &[String], gitignore: bool) -> Result<Self, Failure> {
        let mut builder = GitignoreBuilder::new(root);
        for pattern in exclude {
            builder
                .add_line(None, pattern)
                .map_err(|error| Failure::File {
                    errno: libc::EINVAL,
                    detail: format!("invalid exclude pattern '{pattern}': {error}"),
                })?;
        }
        let exclude = builder.build().map_err(|error| Failure::File {
            errno: libc::EINVAL,
            detail: format!("invalid exclude patterns: {error}"),
        })?;
        let info_exclude = gitignore
            .then(|| matcher(root, &root.join(".git/info/exclude")))
            .flatten();
        Ok(Self {
            exclude,
            gitignore,
            info_exclude,
        })
    }

    /// Git's precedence: the caller's patterns, then `.gitignore` files from the deepest up,
    /// then `.git/info/exclude`. The first matcher with an opinion decides.
    fn excludes(&self, nested: &[Gitignore], path: &Path, is_dir: bool) -> bool {
        std::iter::once(&self.exclude)
            .chain(nested.iter().rev())
            .chain(self.info_exclude.iter())
            .find_map(|matcher| match matcher.matched(path, is_dir) {
                Match::None => None,
                Match::Ignore(_) => Some(true),
                Match::Whitelist(_) => Some(false),
            })
            .unwrap_or(false)
    }
}

fn matcher(root: &Path, file: &Path) -> Option<Gitignore> {
    if !file.is_file() {
        return None;
    }
    let mut builder = GitignoreBuilder::new(root);
    // Git skips lines it can't parse, and so does this.
    let _ = builder.add(file);
    builder.build().ok()
}

/// Writes `root` into `output` as a tar stream and returns `output`. A file that can't be read
/// fails with its own file error, not as a failure writing the archive.
pub(super) fn capture<W: Write>(
    root: &Path,
    selection: &Selection,
    output: W,
    aborted: &dyn Fn() -> bool,
) -> Result<W, Failure> {
    let status = sys::lstatx(root.as_os_str())
        .map_err(|error| file_failure(error, root.as_os_str().as_bytes()))?;
    if status.file_type() != libc::S_IFDIR {
        return Err(Failure::File {
            errno: libc::ENOTDIR,
            detail: format!("{}: not a directory", root.display()),
        });
    }
    let mut walk = Walk {
        builder: tar::Builder::new(output),
        selection,
        root_mount: status.mount,
        links: HashMap::new(),
        aborted,
    };
    walk.emit(b"./", &status, Kind::Directory, &mut io::empty())?;
    walk.directory(root.to_path_buf(), Vec::new(), &mut Vec::new())?;
    walk.builder.into_inner().map_err(Failure::writing)
}

enum Kind<'a> {
    Directory,
    File,
    Symlink(&'a [u8]),
    HardLink(&'a [u8]),
}

struct Walk<'a, W: Write> {
    builder: tar::Builder<W>,
    selection: &'a Selection,
    root_mount: (u32, u32, Option<u64>),
    links: HashMap<(u32, u32, u64), Vec<u8>>,
    aborted: &'a dyn Fn() -> bool,
}

impl<W: Write> Walk<'_, W> {
    fn directory(
        &mut self,
        path: PathBuf,
        relative: Vec<u8>,
        nested: &mut Vec<Gitignore>,
    ) -> Result<(), Failure> {
        let mut names = fs::read_dir(&path)
            .and_then(|entries| {
                entries
                    .map(|entry| entry.map(|entry| entry.file_name()))
                    .collect::<io::Result<Vec<OsString>>>()
            })
            .map_err(|error| file_failure(error, path.as_os_str().as_bytes()))?;
        names.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));

        let pushed = if self.selection.gitignore {
            matcher(&path, &path.join(".gitignore")).map(|matcher| nested.push(matcher))
        } else {
            None
        };
        for name in names {
            if (self.aborted)() {
                return Err(Failure::Aborted);
            }
            let child = path.join(&name);
            let mut child_relative = relative.clone();
            if !child_relative.is_empty() {
                child_relative.push(b'/');
            }
            child_relative.extend_from_slice(name.as_bytes());
            let status = match sys::lstatx(child.as_os_str()) {
                Ok(status) => status,
                // Removed since the directory was read.
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => continue,
                Err(error) => return Err(file_failure(error, child.as_os_str().as_bytes())),
            };
            let is_dir = status.file_type() == libc::S_IFDIR;
            if self.selection.excludes(nested, &child, is_dir) {
                continue;
            }
            match status.file_type() {
                libc::S_IFDIR => {
                    let mut name = child_relative.clone();
                    name.push(b'/');
                    self.emit(&name, &status, Kind::Directory, &mut io::empty())?;
                    // A mount point inside the directory is kept as an empty directory.
                    if status.mount == self.root_mount {
                        self.directory(child, child_relative, nested)?;
                    }
                }
                libc::S_IFLNK => {
                    let target = fs::read_link(&child)
                        .map_err(|error| file_failure(error, child.as_os_str().as_bytes()))?;
                    let target = target.into_os_string().into_vec();
                    self.emit(
                        &child_relative,
                        &status,
                        Kind::Symlink(&target),
                        &mut io::empty(),
                    )?;
                }
                libc::S_IFREG if status.mount == self.root_mount => {
                    self.file(&child, child_relative, &status)?;
                }
                // Sockets, devices, FIFOs, and files mounted from elsewhere.
                _ => {}
            }
        }
        if pushed.is_some() {
            nested.pop();
        }
        Ok(())
    }

    fn file(&mut self, path: &Path, relative: Vec<u8>, status: &Status) -> Result<(), Failure> {
        let identity = (status.mount.0, status.mount.1, status.ino);
        if status.nlink > 1
            && let Some(first) = self.links.get(&identity).cloned()
        {
            return self.emit(&relative, status, Kind::HardLink(&first), &mut io::empty());
        }
        let file = match File::options()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
        {
            Ok(file) => file,
            // Removed since the directory was read.
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
            Err(error) => return Err(file_failure(error, path.as_os_str().as_bytes())),
        };
        if status.nlink > 1 {
            self.links.insert(identity, relative.clone());
        }
        // A file that shrinks while it is read is padded with zeros to the size recorded in its
        // header, and one that grows is cut there, so the archive stays valid.
        let mut data = Source {
            file,
            path: path.as_os_str().as_bytes().to_vec(),
        }
        .take(status.size)
        .chain(io::repeat(0))
        .take(status.size);
        self.emit(&relative, status, Kind::File, &mut data)
    }

    fn emit(
        &mut self,
        name: &[u8],
        status: &Status,
        kind: Kind<'_>,
        data: &mut dyn Read,
    ) -> Result<(), Failure> {
        let mut header = tar::Header::new_ustar();
        let (entry_type, size, link) = match kind {
            Kind::Directory => (tar::EntryType::Directory, 0, None),
            Kind::File => (tar::EntryType::Regular, status.size, None),
            Kind::Symlink(target) => (tar::EntryType::Symlink, 0, Some(target)),
            Kind::HardLink(target) => (tar::EntryType::Link, 0, Some(target)),
        };
        header.set_entry_type(entry_type);
        header.set_mode(status.mode & 0o7777);
        header.set_uid(u64::from(status.uid));
        header.set_gid(u64::from(status.gid));
        header.set_mtime(status.mtime.0.max(0) as u64);
        header.set_size(size);

        let mut pax: Vec<(&str, Vec<u8>)> = Vec::new();
        if status.mtime.1 != 0 || status.mtime.0 < 0 {
            pax.push(("mtime", pax_time(status.mtime).into_bytes()));
        }
        let binary = std::str::from_utf8(name).is_err()
            || link.is_some_and(|link| std::str::from_utf8(link).is_err());
        let fields = header
            .as_ustar_mut()
            .expect("new_ustar() creates a ustar header");
        if !set_field(&mut fields.name, name) {
            pax.push(("path", name.to_vec()));
        }
        if let Some(link) = link
            && !set_field(&mut fields.linkname, link)
        {
            pax.push(("linkpath", link.to_vec()));
        }
        if binary
            && pax
                .iter()
                .any(|(key, _)| *key == "path" || *key == "linkpath")
        {
            pax.push(("hdrcharset", b"BINARY".to_vec()));
        }
        header.set_cksum();

        let written = if pax.is_empty() {
            Ok(())
        } else {
            self.builder
                .append_pax_extensions(pax.iter().map(|(key, value)| (*key, value.as_slice())))
        }
        .and_then(|()| self.builder.append(&header, data));
        written.map_err(Failure::writing)
    }
}

/// Stores `value` in a fixed ustar field when it fits, leaving a truncated copy otherwise.
fn set_field(field: &mut [u8], value: &[u8]) -> bool {
    let count = value.len().min(field.len());
    field[..count].copy_from_slice(&value[..count]);
    value.len() <= field.len()
}

/// PAX times are a signed decimal number of seconds.
fn pax_time((seconds, nanoseconds): (i64, u32)) -> String {
    if seconds < 0 && nanoseconds > 0 {
        format!("-{}.{:09}", -(seconds + 1), 1_000_000_000 - nanoseconds)
    } else {
        format!("{seconds}.{nanoseconds:09}")
    }
}

/// A file being archived. A failed read carries that file's error through tar.
struct Source {
    file: File,
    path: Vec<u8>,
}

impl Read for Source {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.file.read(buffer).map_err(|error| {
            let errno = error.raw_os_error().unwrap_or(libc::EIO);
            file_failure(io::Error::from_raw_os_error(errno), &self.path).into()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn a_file_that_fails_to_read_fails_with_its_own_error_through_tar() {
        let directory = TempDir::new();
        // Reading a directory's descriptor fails with EISDIR.
        let mut source = Source {
            file: File::open(&directory.0).unwrap(),
            path: b"unreadable".to_vec(),
        };
        let mut header = tar::Header::new_ustar();
        header.set_size(1);
        header.set_cksum();

        let error = tar::Builder::new(Vec::new())
            .append(&header, &mut source)
            .unwrap_err();

        assert!(matches!(
            Failure::writing(error),
            Failure::File {
                errno: libc::EISDIR,
                ..
            }
        ));
    }

    #[test]
    fn formats_pax_times_as_signed_decimals() {
        assert_eq!(pax_time((12, 5)), "12.000000005");
        assert_eq!(pax_time((-2, 500_000_000)), "-1.500000000");
        assert_eq!(pax_time((-1, 0)), "-1.000000000");
    }
}
