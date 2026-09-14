use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::model::{ControlError, Marker, PROTOCOL_VERSION, validate_marker};

#[derive(Debug)]
pub(super) enum StoredMarker {
    Absent,
    Current(Box<Marker>),
    Incompatible { protocol_version: u32 },
}

pub(super) fn read(mount_path: &Path, control_root: &Path) -> Result<StoredMarker, ControlError> {
    let path = marker_path(control_root, mount_path);
    let encoded = match fs::read(&path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(StoredMarker::Absent),
        Err(error) => {
            return Err(ControlError::Protocol(format!(
                "cannot read mount marker: {error}"
            )));
        }
    };
    let value: Value = serde_json::from_slice(&encoded)
        .map_err(|error| ControlError::Protocol(format!("invalid mount marker: {error}")))?;
    let protocol_version = value
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or_else(|| {
            ControlError::Protocol("mount marker has no valid protocol version".into())
        })?;
    let recorded_path = value
        .get("mountPath")
        .and_then(Value::as_str)
        .ok_or_else(|| ControlError::Protocol("mount marker has no valid mount path".into()))?;
    if recorded_path.as_bytes() != mount_path.as_os_str().as_bytes() {
        return Err(ControlError::Protocol(
            "mount marker path does not match its control path".into(),
        ));
    }
    if protocol_version != PROTOCOL_VERSION {
        return Ok(StoredMarker::Incompatible { protocol_version });
    }
    let marker: Marker = serde_json::from_value(value)
        .map_err(|error| ControlError::Protocol(format!("invalid mount marker: {error}")))?;
    validate_marker(&marker)?;
    Ok(StoredMarker::Current(Box::new(marker)))
}

pub(super) fn write(marker: &Marker, control_root: &Path) -> Result<(), ControlError> {
    let marker_dir = control_root.join("markers");
    fs::create_dir_all(&marker_dir).map_err(|error| {
        ControlError::Failed(format!("cannot create marker directory: {error}"))
    })?;
    let destination = marker_path(control_root, Path::new(&marker.mount_path));
    let temporary = destination.with_extension("json.tmp");
    let encoded = serde_json::to_vec(marker)
        .map_err(|error| ControlError::Protocol(format!("cannot encode mount marker: {error}")))?;
    fs::write(&temporary, encoded)
        .map_err(|error| ControlError::Failed(format!("cannot write mount marker: {error}")))?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| ControlError::Failed(format!("cannot protect mount marker: {error}")))?;
    fs::rename(&temporary, destination)
        .map_err(|error| ControlError::Failed(format!("cannot install mount marker: {error}")))
}

pub(super) fn remove(marker: &Marker, control_root: &Path) -> Result<(), ControlError> {
    remove_support(&marker.route_id, control_root)?;
    remove_file_if_present(&marker_path(control_root, Path::new(&marker.mount_path)))
}

pub(super) fn remove_support(route_id: &str, control_root: &Path) -> Result<(), ControlError> {
    match fs::remove_dir_all(support_dir(control_root, route_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ControlError::Failed(format!(
            "cannot remove mount support directory: {error}"
        ))),
    }
}

fn remove_file_if_present(path: &Path) -> Result<(), ControlError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ControlError::Failed(format!(
            "cannot remove mount marker: {error}"
        ))),
    }
}

pub(super) fn marker_path(control_root: &Path, mount_path: &Path) -> PathBuf {
    control_root
        .join("markers")
        .join(format!("{}.json", path_hash(mount_path)))
}

pub(super) fn support_dir(control_root: &Path, route_id: &str) -> PathBuf {
    control_root.join("routes").join(route_id)
}

fn path_hash(path: &Path) -> String {
    let digest = Sha256::digest(path.as_os_str().as_bytes());
    format!("{digest:x}")
}

pub(super) struct PathLock(File);

impl PathLock {
    pub(super) fn acquire(mount_path: &Path, control_root: &Path) -> Result<Self, ControlError> {
        let lock_dir = control_root.join("locks");
        fs::create_dir_all(&lock_dir).map_err(|error| {
            ControlError::Failed(format!("cannot create lock directory: {error}"))
        })?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_dir.join(path_hash(mount_path)))
            .map_err(|error| ControlError::Failed(format!("cannot open mount lock: {error}")))?;
        // SAFETY: `file` owns this valid descriptor until the PathLock is dropped.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result != 0 {
            return Err(ControlError::Failed(format!(
                "cannot lock mount path: {}",
                io::Error::last_os_error()
            )));
        }
        Ok(Self(file))
    }
}

impl Drop for PathLock {
    fn drop(&mut self) {
        // SAFETY: the descriptor remains valid while `self.0` is alive.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    use super::super::test_fixtures::marker;

    #[test]
    fn marker_file_is_keyed_by_the_exact_mount_path() {
        let control = TempDir::new();
        let mount_path = Path::new("/mnt/data with spaces");
        let value = marker(mount_path);
        write(&value, &control.0).unwrap();

        let loaded = read(mount_path, &control.0).unwrap();
        assert!(
            matches!(loaded, StoredMarker::Current(found) if found.mount_path == value.mount_path)
        );
    }

    #[test]
    fn malformed_marker_is_a_protocol_error() {
        let control = TempDir::new();
        let mount_path = Path::new("/mnt/data");
        let destination = marker_path(&control.0, mount_path);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(destination, b"not json").unwrap();

        let error = read(mount_path, &control.0).unwrap_err();
        assert!(matches!(error, ControlError::Protocol(_)));
    }

    #[test]
    fn recognizes_incompatible_marker_versions() {
        let control = TempDir::new();
        let mount_path = Path::new("/mnt/data");
        let destination = marker_path(&control.0, mount_path);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(
            destination,
            br#"{"protocolVersion":2,"mountPath":"/mnt/data"}"#,
        )
        .unwrap();

        let loaded = read(mount_path, &control.0).unwrap();
        assert!(matches!(
            loaded,
            StoredMarker::Incompatible {
                protocol_version: 2
            }
        ));
    }
}
