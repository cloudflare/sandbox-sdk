use std::path::Path;

use super::linux_mount::{MountEntry, entries_at, is_managed, read_mountinfo, statfs_state};
use super::marker_store::{self, StoredMarker};
use super::model::{ControlError, GuestMountState};

pub(super) fn inspect(
    mount_path: &Path,
    control_root: &Path,
    mountinfo_path: &Path,
) -> Result<GuestMountState, ControlError> {
    let marker = marker_store::read(mount_path, control_root)?;
    let entries = read_mountinfo(mountinfo_path)?;
    inspect_from(marker, mount_path, &entries)
}

fn inspect_from(
    marker: StoredMarker,
    mount_path: &Path,
    entries: &[MountEntry],
) -> Result<GuestMountState, ControlError> {
    let at_path = entries_at(entries, mount_path);
    match marker {
        StoredMarker::Absent => Ok(match at_path.last() {
            Some(entry) => GuestMountState::Unmanaged {
                filesystem_type: entry.filesystem_type.clone(),
            },
            None => GuestMountState::Absent,
        }),
        StoredMarker::Incompatible { protocol_version } => {
            Ok(GuestMountState::Incompatible { protocol_version })
        }
        StoredMarker::Current(marker) if at_path.is_empty() => {
            Ok(GuestMountState::Stale { marker: *marker })
        }
        StoredMarker::Current(marker) if !is_managed(&at_path, &marker.route_id) => {
            Ok(GuestMountState::Unmanaged {
                filesystem_type: at_path
                    .last()
                    .expect("non-empty attachment list")
                    .filesystem_type
                    .clone(),
            })
        }
        StoredMarker::Current(marker) => Ok(GuestMountState::Managed {
            fuse: statfs_state(mount_path),
            marker: *marker,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    use super::super::model::{FuseState, fsname};
    use super::super::test_fixtures::marker;
    use crate::test_support::TempDir;

    #[test]
    fn reports_absent_managed_and_unmanaged_attachments() {
        let temporary = TempDir::new();
        let path = temporary.0.as_path();
        let absent = inspect_from(StoredMarker::Absent, path, &[]).unwrap();
        assert!(matches!(absent, GuestMountState::Absent));

        let managed_marker = marker(path);
        let entry = MountEntry {
            mount_point: path.as_os_str().as_bytes().to_vec(),
            filesystem_type: "fuse".into(),
            source: fsname(&managed_marker.route_id),
        };
        let managed = inspect_from(
            StoredMarker::Current(Box::new(managed_marker)),
            path,
            &[entry],
        )
        .unwrap();
        assert!(matches!(
            managed,
            GuestMountState::Managed {
                fuse: FuseState::Connected,
                ..
            }
        ));

        let unmanaged = inspect_from(
            StoredMarker::Absent,
            path,
            &[MountEntry {
                mount_point: path.as_os_str().as_bytes().to_vec(),
                filesystem_type: "ext4".into(),
                source: "/dev/vda".into(),
            }],
        )
        .unwrap();
        assert!(matches!(unmanaged, GuestMountState::Unmanaged { .. }));
    }

    #[test]
    fn stale_marker_is_recoverable_guest_state() {
        let path = Path::new("/mnt/data");
        let state = inspect_from(StoredMarker::Current(Box::new(marker(path))), path, &[]).unwrap();

        assert!(matches!(state, GuestMountState::Stale { .. }));
    }
}
