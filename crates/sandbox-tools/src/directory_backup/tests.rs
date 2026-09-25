//! Capture and extraction together without transport, and how failures cross zstd.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use super::capture::{Selection, capture};
use super::extract::Extractor;
use super::transfer::{PartSink, RangeReader};
use super::{Failure, sys};
use crate::test_support::TempDir;

fn archive(root: &Path, exclude: &[&str], gitignore: bool) -> Vec<u8> {
    let exclude: Vec<String> = exclude.iter().map(|pattern| pattern.to_string()).collect();
    let selection = Selection::new(root, &exclude, gitignore).unwrap();
    capture(root, &selection, Vec::new(), &|| false).unwrap()
}

fn extract(archive: &[u8], destination: &Path) -> Result<(), Failure> {
    fs::create_dir(destination).unwrap();
    let fd = sys::open_directory(destination.as_os_str()).unwrap();
    let mut extractor = Extractor::new(fd, &|| false)?;
    extractor.extract(&mut &archive[..])?;
    extractor.finish()
}

fn listing(root: &Path) -> Vec<String> {
    let mut entries = Vec::new();
    collect(root, root, &mut entries);
    entries.sort();
    entries
}

fn collect(root: &Path, path: &Path, entries: &mut Vec<String>) {
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        let metadata = fs::symlink_metadata(&path).unwrap();
        let relative = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let kind = if metadata.is_dir() {
            "dir".to_owned()
        } else if metadata.file_type().is_symlink() {
            format!("link->{}", fs::read_link(&path).unwrap().display())
        } else {
            format!(
                "file:{}",
                String::from_utf8_lossy(&fs::read(&path).unwrap())
            )
        };
        entries.push(format!("{relative} {kind} {:o}", metadata.mode() & 0o7777));
        if metadata.is_dir() {
            collect(root, &path, entries);
        }
    }
}

#[test]
fn round_trips_a_tree() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    fs::create_dir_all(source.join("nested/empty")).unwrap();
    fs::write(source.join("nested/file.txt"), b"hello").unwrap();
    fs::write(source.join("script.sh"), b"#!/bin/sh").unwrap();
    fs::set_permissions(source.join("script.sh"), fs::Permissions::from_mode(0o754)).unwrap();
    fs::write(source.join("setuid"), b"x").unwrap();
    fs::set_permissions(source.join("setuid"), fs::Permissions::from_mode(0o4755)).unwrap();
    symlink("nested/file.txt", source.join("inside")).unwrap();
    symlink("/etc/passwd", source.join("outside")).unwrap();
    fs::hard_link(source.join("nested/file.txt"), source.join("hard")).unwrap();
    let long_name = "n".repeat(150);
    fs::write(source.join(&long_name), b"long").unwrap();
    symlink("t".repeat(150), source.join("long-link")).unwrap();
    fs::write(source.join("line\nbreak"), b"newline").unwrap();
    // Too long for the ustar field, so the newline travels inside a PAX record.
    fs::write(
        source.join(format!("{}\n{}", "a".repeat(60), "b".repeat(60))),
        b"x",
    )
    .unwrap();
    fs::write(source.join(OsStr::from_bytes(b"bad-\xff")), b"binary").unwrap();
    fs::set_permissions(source.join("nested"), fs::Permissions::from_mode(0o750)).unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o710)).unwrap();
    set_mtime(
        &source.join("nested/file.txt"),
        (1_700_000_000, 123_456_789),
    );
    set_mtime(&source.join("nested"), (1_600_000_000, 987_654_321));

    let destination = temp.0.join("restored");
    extract(&archive(&source, &[], false), &destination).unwrap();

    let mut expected = listing(&source);
    for line in &mut expected {
        if line.starts_with("setuid ") {
            *line = line.replace(" 4755", " 755");
        }
    }
    assert_eq!(listing(&destination), expected);
    let restored = fs::metadata(destination.join("hard")).unwrap();
    assert_eq!(
        restored.ino(),
        fs::metadata(destination.join("nested/file.txt"))
            .unwrap()
            .ino()
    );
    let file = fs::metadata(destination.join("nested/file.txt")).unwrap();
    assert_eq!(
        (file.mtime(), file.mtime_nsec()),
        (1_700_000_000, 123_456_789)
    );
    let nested = fs::metadata(destination.join("nested")).unwrap();
    assert_eq!(
        (nested.mtime(), nested.mtime_nsec()),
        (1_600_000_000, 987_654_321)
    );
    assert_eq!(fs::metadata(&destination).unwrap().mode() & 0o7777, 0o710);
    assert!(fs::symlink_metadata(destination.join(OsStr::from_bytes(b"bad-\xff"))).is_ok());
}

#[test]
fn round_trips_an_empty_directory() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    fs::create_dir(&source).unwrap();

    let destination = temp.0.join("restored");
    extract(&archive(&source, &[], false), &destination).unwrap();

    assert!(listing(&destination).is_empty());
}

#[test]
fn applies_exclude_patterns_and_gitignore_files() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    for directory in [
        "node_modules/pkg",
        "src/node_modules",
        "build",
        "src/build",
        ".git/info",
    ] {
        fs::create_dir_all(source.join(directory)).unwrap();
    }
    for file in [
        "node_modules/pkg/index.js",
        "src/node_modules/x.js",
        "build/out",
        "src/build/out",
        "a.log",
        "keep.log",
        "src/generated.rs",
        "src/main.rs",
        "secret.env",
        ".git/HEAD",
    ] {
        fs::write(source.join(file), file).unwrap();
    }
    fs::write(source.join("src/.gitignore"), "generated.rs\n").unwrap();
    fs::write(source.join(".gitignore"), "*.env\n").unwrap();
    fs::write(source.join(".git/info/exclude"), "keep.log\n").unwrap();

    let names = |gitignore| {
        let destination = temp.0.join(format!("restored-{gitignore}"));
        extract(
            &archive(
                &source,
                &["node_modules/", "*.log", "!keep.log", "/build"],
                gitignore,
            ),
            &destination,
        )
        .unwrap();
        listing(&destination)
            .into_iter()
            .map(|line| line.split(' ').next().unwrap().to_owned())
            .collect::<Vec<_>>()
    };

    let with_gitignore = names(true);
    assert_eq!(
        with_gitignore,
        vec![
            ".git",
            ".git/HEAD",
            ".git/info",
            ".git/info/exclude",
            ".gitignore",
            "keep.log",
            "src",
            "src/.gitignore",
            "src/build",
            "src/build/out",
            "src/main.rs",
        ]
    );
    let without_gitignore = names(false);
    assert!(without_gitignore.contains(&"secret.env".to_owned()));
    assert!(without_gitignore.contains(&"src/generated.rs".to_owned()));
}

#[test]
fn rejects_an_invalid_exclude_pattern() {
    let temp = TempDir::new();

    let result = Selection::new(&temp.0, &["{a".to_owned()], false);

    assert!(matches!(
        result,
        Err(Failure::File {
            errno: libc::EINVAL,
            ..
        })
    ));
}

#[test]
fn skips_special_files() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    fs::create_dir(&source).unwrap();
    let fifo = std::ffi::CString::new(source.join("fifo").as_os_str().as_bytes()).unwrap();
    // SAFETY: `fifo` is NUL-terminated.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
    fs::write(source.join("file"), b"x").unwrap();

    let destination = temp.0.join("restored");
    extract(&archive(&source, &[], false), &destination).unwrap();

    assert_eq!(listing(&destination), vec!["file file:x 644"]);
}

/// Builds a tar stream entry by entry, for archives the shim would never write.
struct Hostile(tar::Builder<Vec<u8>>);

fn header(kind: tar::EntryType, path: &[u8], mode: u32, size: u64) -> tar::Header {
    let mut header = tar::Header::new_ustar();
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_size(size);
    header.as_ustar_mut().unwrap().name[..path.len()].copy_from_slice(path);
    header
}

impl Hostile {
    fn new() -> Self {
        let mut hostile = Self(tar::Builder::new(Vec::new()));
        hostile.entry(tar::EntryType::Directory, b"./", None, b"");
        hostile
    }

    fn entry(&mut self, kind: tar::EntryType, path: &[u8], link: Option<&[u8]>, data: &[u8]) {
        let mut header = header(kind, path, 0o755, data.len() as u64);
        if let Some(link) = link {
            header.as_ustar_mut().unwrap().linkname[..link.len()].copy_from_slice(link);
        }
        header.set_cksum();
        self.0.append(&header, data).unwrap();
    }

    fn mode(mut self, path: &[u8], mode: u32) -> Self {
        let mut header = header(tar::EntryType::Regular, path, mode, 1);
        header.set_cksum();
        self.0.append(&header, &b"x"[..]).unwrap();
        self
    }

    fn with(mut self, kind: tar::EntryType, path: &[u8], link: Option<&[u8]>) -> Self {
        self.entry(kind, path, link, b"data");
        self
    }

    fn bytes(self) -> Vec<u8> {
        self.0.into_inner().unwrap()
    }
}

fn assert_integrity(archive: Vec<u8>) -> PathBuf {
    let temp = TempDir::new();
    let destination = temp.0.join("restored");
    let result = extract(&archive, &destination);
    assert!(
        matches!(result, Err(Failure::Integrity(_))),
        "expected an integrity failure, got {result:?}"
    );
    assert!(!temp.0.join("escaped").exists());
    destination
}

#[test]
fn rejects_entries_that_leave_the_directory() {
    use tar::EntryType::{Link, Regular, Symlink};

    assert_integrity(Hostile::new().with(Regular, b"../escaped", None).bytes());
    assert_integrity(Hostile::new().with(Regular, b"/tmp/escaped", None).bytes());
    assert_integrity(
        Hostile::new()
            .with(Symlink, b"up", Some(b".."))
            .with(Regular, b"up/escaped", None)
            .bytes(),
    );
    assert_integrity(
        Hostile::new()
            .with(Link, b"hard", Some(b"../escaped"))
            .bytes(),
    );
    assert_integrity(Hostile::new().with(Link, b"hard", Some(b"missing")).bytes());
}

#[test]
fn rejects_duplicate_entries_and_missing_directories() {
    use tar::EntryType::Regular;

    assert_integrity(
        Hostile::new()
            .with(Regular, b"twice", None)
            .with(Regular, b"twice", None)
            .bytes(),
    );
    assert_integrity(Hostile::new().with(Regular, b"missing/file", None).bytes());
}

#[test]
fn never_creates_devices_or_setuid_files() {
    let temp = TempDir::new();
    let destination = temp.0.join("restored");
    let archive = Hostile::new()
        .with(tar::EntryType::Char, b"null", None)
        .with(tar::EntryType::Fifo, b"fifo", None)
        .mode(b"setuid", 0o6755)
        .bytes();

    extract(&archive, &destination).unwrap();

    assert_eq!(listing(&destination), vec!["setuid file:x 755"]);
}

#[test]
fn requires_a_root_entry() {
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = header(tar::EntryType::Regular, b"file", 0o644, 0);
    header.set_cksum();
    builder.append(&header, io::empty()).unwrap();

    assert_integrity(builder.into_inner().unwrap());
}

#[test]
fn truncated_archives_fail() {
    let temp = TempDir::new();
    let source = temp.0.join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file"), vec![7u8; 4096]).unwrap();
    let mut bytes = archive(&source, &[], false);
    bytes.truncate(2048);

    assert_integrity(bytes);
}

fn set_mtime(path: &Path, mtime: (i64, u32)) {
    let fd = fs::File::open(path).unwrap();
    sys::set_mtime_fd(fd.as_raw_fd(), mtime).unwrap();
}

// The package tells a rejected part from a failed compression by the failure the part carries.
#[test]
fn a_rejected_part_reaches_the_caller_through_zstd() {
    let sink = PartSink::new(|_, _| Err(Failure::Transfer("rejected".into())), 64, 1);
    let mut encoder = zstd::stream::write::Encoder::new(sink, 1).unwrap();
    let noise: Vec<u8> = (0..1_000_000u32)
        .map(|index| (index.wrapping_mul(2_654_435_761) >> 24) as u8)
        .collect();

    let error = encoder
        .write_all(&noise)
        .and_then(|()| encoder.finish().map(drop))
        .unwrap_err();

    assert!(matches!(Failure::writing(error), Failure::Transfer(detail) if detail == "rejected"));
}

#[test]
fn a_missing_object_reaches_the_caller_through_zstd() {
    let ranges = RangeReader::new(|_, _| Err(Failure::NotFound("gone".into())), 100, 10, 2);
    let mut decoder = zstd::stream::read::Decoder::new(ranges).unwrap();

    let error = decoder.read_to_end(&mut Vec::new()).unwrap_err();

    assert!(matches!(Failure::reading(error), Failure::NotFound(_)));
}
