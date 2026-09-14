mod gateway_probe;
mod linux_mount;
mod marker_store;
mod model;
mod observation;

use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

use serde_json::{Value, json};

use self::marker_store::{PathLock, StoredMarker};
use self::model::{
    CONTROL_ROOT, ControlError, FuseState, GuestMountState, MOUNTINFO_PATH, MountRequest, to_value,
};
use crate::protocol;

const ROUTE_READY: u8 = 1;

pub(crate) fn run(
    args: &[String],
    input: &mut impl Read,
    output: &mut impl Write,
) -> io::Result<()> {
    let control_root = Path::new(CONTROL_ROOT);
    let mountinfo_path = Path::new(MOUNTINFO_PATH);
    match args {
        [subcommand, request] if subcommand == "mount" => {
            let request = MountRequest::parse(request);
            match request {
                Ok(request) => mount(request, input, output, control_root, mountinfo_path),
                Err(error) => write_result(output, Err(error)),
            }
        }
        [subcommand, mount_path] if subcommand == "inspect" => {
            let result = model::validate_mount_path(mount_path)
                .and_then(|()| inspect(Path::new(mount_path), control_root, mountinfo_path))
                .and_then(to_value);
            write_result(output, result)
        }
        [subcommand, mount_path] if subcommand == "unmount" => {
            match model::validate_mount_path(mount_path) {
                Ok(()) => unmount(
                    Path::new(mount_path),
                    input,
                    output,
                    control_root,
                    mountinfo_path,
                ),
                Err(error) => write_result(output, Err(error)),
            }
        }
        _ => write_result(
            output,
            Err(ControlError::Protocol(
                "usage: sandbox-shim s3-mount <mount|inspect|unmount> <argument>".into(),
            )),
        ),
    }
}

fn mount(
    request: MountRequest,
    input: &mut impl Read,
    output: &mut impl Write,
    control_root: &Path,
    mountinfo_path: &Path,
) -> io::Result<()> {
    let plan = prepare_mount(request, control_root, mountinfo_path);
    let plan = match plan {
        Ok(plan) => plan,
        Err(error) => return write_result(output, Err(error)),
    };

    write_result(
        output,
        Ok(json!({ "kind": "route", "routeId": &plan.marker.route_id })),
    )?;
    if let Err(error) = read_route_ready(input) {
        return write_result(output, Err(error));
    }
    write_result(
        output,
        plan.complete(control_root, mountinfo_path)
            .map(|()| Value::Null),
    )
}

struct MountPlan {
    _lock: PathLock,
    marker: model::Marker,
    action: MountAction,
}

enum MountAction {
    Adopt,
    Repair,
    Start,
}

impl MountPlan {
    fn complete(self, control_root: &Path, mountinfo_path: &Path) -> Result<(), ControlError> {
        if matches!(self.action, MountAction::Adopt) {
            return Ok(());
        }
        let mount_path = Path::new(&self.marker.mount_path);
        if matches!(self.action, MountAction::Repair) {
            linux_mount::normal_unmount(mount_path)?;
        }
        linux_mount::start_s3fs(&self.marker, control_root, mountinfo_path)
    }
}

fn prepare_mount(
    request: MountRequest,
    control_root: &Path,
    mountinfo_path: &Path,
) -> Result<MountPlan, ControlError> {
    fs::create_dir_all(control_root).map_err(|error| {
        ControlError::Failed(format!("cannot create mount control directory: {error}"))
    })?;
    let mount_path = Path::new(&request.mount_path);
    let lock = PathLock::acquire(mount_path, control_root)?;
    let state = observation::inspect(mount_path, control_root, mountinfo_path)?;

    let (marker, action) = match state {
        GuestMountState::Managed { marker, fuse } => {
            if marker.configuration != request.configuration {
                return Err(ControlError::Conflict(
                    "a managed mount with a different configuration occupies the path".into(),
                ));
            }
            let action = match fuse {
                FuseState::Connected => MountAction::Adopt,
                FuseState::Disconnected => MountAction::Repair,
                FuseState::Indeterminate { detail } => {
                    return Err(ControlError::Failed(format!(
                        "cannot verify the managed FUSE connection: {detail}"
                    )));
                }
            };
            (marker, action)
        }
        GuestMountState::Unmanaged { .. } => {
            return Err(ControlError::Conflict(
                "an unmanaged filesystem occupies the mount path".into(),
            ));
        }
        GuestMountState::Incompatible { protocol_version } => {
            return Err(ControlError::Incompatible(format!(
                "mount marker protocol {protocol_version} is not supported"
            )));
        }
        GuestMountState::Stale { marker } => {
            if marker.configuration != request.configuration {
                return Err(ControlError::Conflict(
                    "stale mount intent has a different configuration".into(),
                ));
            }
            (marker, MountAction::Start)
        }
        GuestMountState::Absent => {
            let route_id = request.candidate_route_id.clone();
            (request.into_marker(route_id), MountAction::Start)
        }
    };

    // Persist route identity before Worker-side interception can become active.
    marker_store::write(&marker, control_root)?;

    Ok(MountPlan {
        _lock: lock,
        marker,
        action,
    })
}

fn inspect(
    mount_path: &Path,
    control_root: &Path,
    mountinfo_path: &Path,
) -> Result<Value, ControlError> {
    let state = observation::inspect(mount_path, control_root, mountinfo_path)?;
    let gateway = match &state {
        GuestMountState::Stale { marker } | GuestMountState::Managed { marker, .. } => {
            Some(gateway_probe::probe(marker)?)
        }
        _ => None,
    };
    let mut evidence = serde_json::Map::new();
    evidence.insert("state".into(), to_value(state)?);
    if let Some(gateway) = gateway {
        evidence.insert("gateway".into(), to_value(gateway)?);
    }
    Ok(Value::Object(evidence))
}

fn unmount(
    mount_path: &Path,
    input: &mut impl Read,
    output: &mut impl Write,
    control_root: &Path,
    mountinfo_path: &Path,
) -> io::Result<()> {
    let plan = match prepare_unmount(mount_path, control_root, mountinfo_path) {
        Ok(Some(plan)) => plan,
        Ok(None) => return write_result(output, Ok(Value::Null)),
        Err(error) => return write_result(output, Err(error)),
    };

    write_result(
        output,
        Ok(json!({ "kind": "route", "routeId": &plan.marker.route_id })),
    )?;
    if let Err(error) = read_route_ready(input) {
        return write_result(output, Err(error));
    }
    write_result(output, plan.complete(control_root).map(|()| Value::Null))
}

struct UnmountPlan {
    _lock: PathLock,
    marker: model::Marker,
    mount_path: std::path::PathBuf,
    action: UnmountAction,
}

enum UnmountAction {
    Detach,
    Occupied,
    RemoveIntent,
}

impl UnmountPlan {
    fn complete(self, control_root: &Path) -> Result<(), ControlError> {
        match self.action {
            UnmountAction::Detach => linux_mount::normal_unmount(&self.mount_path)?,
            UnmountAction::Occupied => {
                return Err(ControlError::Conflict(
                    "an unmanaged filesystem occupies the mount path".into(),
                ));
            }
            UnmountAction::RemoveIntent => {}
        }
        marker_store::remove(&self.marker, control_root)
    }
}

fn prepare_unmount(
    mount_path: &Path,
    control_root: &Path,
    mountinfo_path: &Path,
) -> Result<Option<UnmountPlan>, ControlError> {
    fs::create_dir_all(control_root).map_err(|error| {
        ControlError::Failed(format!("cannot create mount control directory: {error}"))
    })?;
    let lock = PathLock::acquire(mount_path, control_root)?;
    let marker = match marker_store::read(mount_path, control_root)? {
        StoredMarker::Absent => {
            let entries = linux_mount::read_mountinfo(mountinfo_path)?;
            if linux_mount::entries_at(&entries, mount_path).is_empty() {
                return Ok(None);
            }
            return Err(ControlError::Conflict(
                "an unmanaged filesystem occupies the mount path".into(),
            ));
        }
        StoredMarker::Incompatible { protocol_version } => {
            return Err(ControlError::Incompatible(format!(
                "mount marker protocol {protocol_version} is not supported"
            )));
        }
        StoredMarker::Current(marker) => *marker,
    };

    let entries = linux_mount::read_mountinfo(mountinfo_path)?;
    let at_path = linux_mount::entries_at(&entries, mount_path);
    let action = if at_path.is_empty() {
        UnmountAction::RemoveIntent
    } else if linux_mount::is_managed(&at_path, &marker.route_id) {
        UnmountAction::Detach
    } else {
        UnmountAction::Occupied
    };
    Ok(Some(UnmountPlan {
        _lock: lock,
        marker,
        mount_path: mount_path.to_path_buf(),
        action,
    }))
}

fn read_route_ready(input: &mut impl Read) -> Result<(), ControlError> {
    let mut acknowledgement = [0];
    input.read_exact(&mut acknowledgement).map_err(|error| {
        ControlError::Protocol(format!("cannot read route acknowledgement: {error}"))
    })?;
    if acknowledgement[0] != ROUTE_READY {
        return Err(ControlError::Protocol(
            "invalid route acknowledgement".into(),
        ));
    }
    Ok(())
}

fn write_result(output: &mut impl Write, result: Result<Value, ControlError>) -> io::Result<()> {
    let payload = match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => error.response(),
    };
    let encoded = serde_json::to_vec(&payload)
        .map_err(|error| io::Error::other(format!("failed to encode response: {error}")))?;
    protocol::write_data(output, &encoded)
}

#[cfg(test)]
mod test_fixtures {
    use std::path::Path;

    use super::model::{Access, Marker, ObservedConfiguration, ObservedSource};

    pub(super) fn configuration() -> ObservedConfiguration {
        ObservedConfiguration {
            source: ObservedSource::S3 {
                endpoint: "http://minio:9000".into(),
                region: "us-east-1".into(),
                bucket: "data".into(),
            },
            key_prefix: Some("models/current/".into()),
            access: Access::ReadOnly,
            s3fs_options: Vec::new(),
        }
    }

    pub(super) fn marker(path: &Path) -> Marker {
        Marker {
            protocol_version: 1,
            route_id: "route-123".into(),
            mount_path: path.to_string_lossy().into_owned(),
            configuration: configuration(),
        }
    }
}

#[cfg(test)]
mod tests {
    use self::test_fixtures::marker;
    use super::*;
    use crate::test_support::TempDir;
    use model::{MountRequest, fsname};

    fn request_from(marker: &model::Marker) -> MountRequest {
        MountRequest {
            protocol_version: marker.protocol_version,
            candidate_route_id: "candidate-route".into(),
            mount_path: marker.mount_path.clone(),
            configuration: marker.configuration.clone(),
        }
    }

    #[test]
    fn identical_managed_mount_selects_its_existing_route() {
        let control = TempDir::new();
        let mount_path = TempDir::new();
        let value = marker(&mount_path.0);
        marker_store::write(&value, &control.0).unwrap();
        let mountinfo = control.0.join("mountinfo");
        fs::write(
            &mountinfo,
            format!(
                "97 54 0:61 / {} rw,nosuid - fuse {} rw\n",
                mount_path.0.display(),
                fsname(&value.route_id)
            ),
        )
        .unwrap();

        let plan = prepare_mount(request_from(&value), &control.0, &mountinfo).unwrap();

        assert_eq!(plan.marker.route_id, value.route_id);
        assert!(matches!(plan.action, MountAction::Adopt));
    }

    #[test]
    fn managed_mount_with_a_different_configuration_conflicts() {
        let control = TempDir::new();
        let mount_path = TempDir::new();
        let value = marker(&mount_path.0);
        marker_store::write(&value, &control.0).unwrap();
        let mountinfo = control.0.join("mountinfo");
        fs::write(
            &mountinfo,
            format!(
                "97 54 0:61 / {} rw,nosuid - fuse {} rw\n",
                mount_path.0.display(),
                fsname(&value.route_id)
            ),
        )
        .unwrap();
        let mut request = request_from(&value);
        request.configuration.access = model::Access::ReadWrite;

        assert!(matches!(
            prepare_mount(request, &control.0, &mountinfo),
            Err(ControlError::Conflict(_))
        ));
    }

    #[test]
    fn absent_mount_persists_route_intent_during_preparation() {
        let control = TempDir::new();
        let mount_path = TempDir::new();
        let value = marker(&mount_path.0);
        let mountinfo = control.0.join("mountinfo");
        fs::write(&mountinfo, b"").unwrap();

        let plan = prepare_mount(request_from(&value), &control.0, &mountinfo).unwrap();
        let stored = marker_store::read(&mount_path.0, &control.0).unwrap();

        assert_eq!(plan.marker.route_id, "candidate-route");
        assert!(matches!(
            stored,
            marker_store::StoredMarker::Current(marker)
                if marker.route_id == "candidate-route"
                    && marker.configuration == value.configuration
        ));
    }

    #[test]
    fn stale_mount_with_a_different_configuration_conflicts() {
        let control = TempDir::new();
        let mount_path = TempDir::new();
        let value = marker(&mount_path.0);
        marker_store::write(&value, &control.0).unwrap();
        let mountinfo = control.0.join("mountinfo");
        fs::write(&mountinfo, b"").unwrap();
        let mut request = request_from(&value);
        request.configuration.access = model::Access::ReadWrite;

        assert!(matches!(
            prepare_mount(request, &control.0, &mountinfo),
            Err(ControlError::Conflict(_))
        ));
    }

    #[test]
    fn absent_unmount_is_idempotent() {
        let control = TempDir::new();
        let mount_path = TempDir::new();
        let mountinfo = control.0.join("mountinfo");
        fs::write(&mountinfo, b"").unwrap();

        assert!(
            prepare_unmount(&mount_path.0, &control.0, &mountinfo)
                .unwrap()
                .is_none()
        );
        assert!(
            prepare_unmount(&mount_path.0, &control.0, &mountinfo)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn shadowed_mount_denies_its_route_before_reporting_conflict() {
        let control = TempDir::new();
        let mount_path = TempDir::new();
        let value = marker(&mount_path.0);
        marker_store::write(&value, &control.0).unwrap();
        let mountinfo = control.0.join("mountinfo");
        fs::write(
            &mountinfo,
            format!(
                "97 54 0:61 / {} rw,nosuid - ext4 /dev/vda rw\n",
                mount_path.0.display()
            ),
        )
        .unwrap();

        let plan = prepare_unmount(&mount_path.0, &control.0, &mountinfo)
            .unwrap()
            .expect("marker route should require denial");
        assert_eq!(plan.marker.route_id, value.route_id);
        assert!(matches!(plan.action, UnmountAction::Occupied));
        assert!(matches!(
            plan.complete(&control.0),
            Err(ControlError::Conflict(_))
        ));
        assert!(matches!(
            marker_store::read(&mount_path.0, &control.0).unwrap(),
            StoredMarker::Current(_)
        ));
    }

    #[test]
    fn route_acknowledgement_is_explicit() {
        read_route_ready(&mut &[ROUTE_READY][..]).unwrap();
        assert!(read_route_ready(&mut &[0][..]).is_err());
    }
}
