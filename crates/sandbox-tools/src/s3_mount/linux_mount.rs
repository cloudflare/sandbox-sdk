use std::ffi::CString;
use std::fs::{self, File};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path};
use std::process::{Command, Stdio};

use super::marker_store::support_dir;
use super::model::{
    Access, ControlError, FuseState, Marker, effective_bucket, fsname,
    overlaps_reserved_guest_path, route_host,
};
use crate::mountinfo;

const MAX_LOG_DETAIL_BYTES: usize = 4 * 1024;

pub(super) use crate::mountinfo::MountEntry;

pub(super) fn read_mountinfo(path: &Path) -> Result<Vec<MountEntry>, ControlError> {
    let bytes = fs::read(path)
        .map_err(|error| ControlError::Failed(format!("cannot read mount table: {error}")))?;
    mountinfo::parse(&bytes).map_err(|error| ControlError::Protocol(error.to_string()))
}

pub(super) fn entries_at<'a>(entries: &'a [MountEntry], mount_path: &Path) -> Vec<&'a MountEntry> {
    let mount_path = mount_path.as_os_str().as_bytes();
    entries
        .iter()
        .filter(|entry| entry.mount_point == mount_path)
        .collect()
}

pub(super) fn is_managed(entries: &[&MountEntry], route_id: &str) -> bool {
    entries.len() == 1
        && entries[0].filesystem_type.starts_with("fuse")
        && entries[0].source == fsname(route_id)
}

pub(super) fn start_s3fs(
    marker: &Marker,
    control_root: &Path,
    mountinfo_path: &Path,
) -> Result<(), ControlError> {
    let mount_path = Path::new(&marker.mount_path);
    prepare_mount_path(mount_path)?;

    let support_dir = support_dir(control_root, &marker.route_id);
    fs::create_dir_all(&support_dir).map_err(|error| {
        ControlError::Failed(format!("cannot create mount support directory: {error}"))
    })?;
    let password_path = support_dir.join("passwd");
    fs::write(&password_path, b"sandbox-access-key:sandbox-secret-key\n").map_err(|error| {
        ControlError::Failed(format!("cannot write s3fs password file: {error}"))
    })?;
    fs::set_permissions(&password_path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        ControlError::Failed(format!("cannot protect s3fs password file: {error}"))
    })?;
    let log_path = support_dir.join("s3fs.log");
    let log = File::create(&log_path)
        .map_err(|error| ControlError::Failed(format!("cannot create s3fs log: {error}")))?;
    let log_error = log
        .try_clone()
        .map_err(|error| ControlError::Failed(format!("cannot open s3fs log: {error}")))?;

    let bucket = effective_bucket(&marker.configuration);
    let source = match &marker.configuration.key_prefix {
        Some(prefix) => format!("{bucket}:/{}", prefix.trim_end_matches('/')),
        None => bucket.to_owned(),
    };

    let mut command = Command::new("s3fs");
    command
        .arg(source)
        .arg(mount_path)
        .args(["-o", "use_path_request_style", "-o", "compat_dir"])
        .args(["-o", "allow_other"])
        // R2 rejects multipart uploads whose non-final parts differ in size, which s3fs produces
        // when it copies the unchanged ranges of a partly rewritten object. Every S3 provider
        // accepts uniform parts, so the option is always on.
        .args(["-o", "nomixupload"])
        .arg("-o")
        .arg(format!("passwd_file={}", password_path.display()))
        .arg("-o")
        .arg(format!("url=http://{}", route_host(&marker.route_id)))
        .arg("-o")
        .arg(format!("fsname={}", fsname(&marker.route_id)));
    if marker.configuration.access == Access::ReadOnly {
        command.args(["-o", "ro"]);
    }
    for option in &marker.configuration.s3fs_options {
        command.arg("-o");
        command.arg(match &option.value {
            Some(value) => format!("{}={value}", option.name),
            None => option.name.clone(),
        });
    }
    let exit_status = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_error))
        .status()
        .map_err(|error| ControlError::Failed(format!("cannot start s3fs: {error}")))?;
    if !exit_status.success() {
        let detail = read_log_tail(&log_path);
        return Err(ControlError::Failed(if detail.is_empty() {
            format!("s3fs exited before mounting ({exit_status})")
        } else {
            format!("s3fs exited before mounting ({exit_status}): {detail}")
        }));
    }

    verify_new_mount(marker, mount_path, mountinfo_path)
}

fn prepare_mount_path(mount_path: &Path) -> Result<(), ControlError> {
    reject_symlink_components(mount_path)?;
    fs::create_dir_all(mount_path)
        .map_err(|error| ControlError::Failed(format!("cannot create mount path: {error}")))?;
    let identity = fs::canonicalize(mount_path)
        .map_err(|error| ControlError::Failed(format!("cannot resolve mount path: {error}")))?;
    if identity.as_os_str().as_bytes() != mount_path.as_os_str().as_bytes() {
        return Err(ControlError::Failed(
            "mount path must not resolve through a symbolic link".into(),
        ));
    }
    let identity = identity
        .to_str()
        .ok_or_else(|| ControlError::Failed("resolved mount path is not valid UTF-8".into()))?;
    if overlaps_reserved_guest_path(identity) {
        return Err(ControlError::Failed(
            "resolved mount path overlaps sandbox control files".into(),
        ));
    }
    Ok(())
}

fn reject_symlink_components(path: &Path) -> Result<(), ControlError> {
    let mut current = std::path::PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(segment) => current.push(segment),
            _ => {
                return Err(ControlError::Protocol(
                    "mount path must be a normalized absolute path".into(),
                ));
            }
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ControlError::Failed(
                    "mount path must not resolve through a symbolic link".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ControlError::Failed(format!(
                    "cannot inspect mount path: {error}"
                )));
            }
        }
    }
    Ok(())
}

fn verify_new_mount(
    marker: &Marker,
    mount_path: &Path,
    mountinfo_path: &Path,
) -> Result<(), ControlError> {
    let entries = read_mountinfo(mountinfo_path)?;
    let at_path = entries_at(&entries, mount_path);
    if at_path.is_empty() {
        return Err(ControlError::Failed(
            "s3fs exited successfully but the FUSE mount did not appear".into(),
        ));
    }
    if !is_managed(&at_path, &marker.route_id) {
        return Err(ControlError::Conflict(
            "a different filesystem appeared at the mount path".into(),
        ));
    }
    match statfs_state(mount_path) {
        FuseState::Connected => Ok(()),
        FuseState::Disconnected => Err(ControlError::Failed(
            "s3fs attached with a disconnected FUSE connection".into(),
        )),
        FuseState::Indeterminate { detail } => Err(ControlError::Failed(format!(
            "cannot verify the new FUSE connection: {detail}"
        ))),
    }
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut bytes) = fs::read(path) else {
        return String::new();
    };
    if bytes.len() > MAX_LOG_DETAIL_BYTES {
        bytes.drain(..bytes.len() - MAX_LOG_DETAIL_BYTES);
    }
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

pub(super) fn statfs_state(path: &Path) -> FuseState {
    let encoded = match CString::new(path.as_os_str().as_bytes()) {
        Ok(encoded) => encoded,
        Err(_) => {
            return FuseState::Indeterminate {
                detail: "mount path contains a NUL byte".into(),
            };
        }
    };
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `encoded` and `stat` point to valid memory for the duration of the call.
    let result = unsafe { libc::statfs(encoded.as_ptr(), stat.as_mut_ptr()) };
    if result == 0 {
        return FuseState::Connected;
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOTCONN) {
        FuseState::Disconnected
    } else {
        FuseState::Indeterminate {
            detail: error.to_string(),
        }
    }
}

pub(super) fn normal_unmount(mount_path: &Path) -> Result<(), ControlError> {
    let encoded = CString::new(mount_path.as_os_str().as_bytes())
        .map_err(|_| ControlError::Protocol("mount path contains a NUL byte".into()))?;
    // SAFETY: `encoded` is a live, NUL-terminated path and flags=0 requests a normal unmount.
    let result = unsafe { libc::umount2(encoded.as_ptr(), 0) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EBUSY) {
        return Err(ControlError::Busy(format!(
            "normal unmount reported a busy mount: {error}"
        )));
    }
    Err(ControlError::Failed(format!(
        "normal unmount failed: {error}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::os::unix::fs::symlink;

    #[test]
    fn rejects_symlinks_before_creating_descendants() {
        let temporary = TempDir::new();
        let outside = TempDir::new();
        let link = temporary.0.join("link");
        symlink(&outside.0, &link).unwrap();
        let mount_path = link.join("new");

        assert!(prepare_mount_path(&mount_path).is_err());
        assert!(!outside.0.join("new").exists());
    }
}
