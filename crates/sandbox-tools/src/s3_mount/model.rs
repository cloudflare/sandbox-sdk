use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(super) const PROTOCOL_VERSION: u32 = 1;
pub(super) const CONTROL_ROOT: &str = "/run/sandbox/s3-mounts";
pub(super) const MOUNTINFO_PATH: &str = "/proc/self/mountinfo";

const RESERVED_GUEST_PATHS: [&str; 3] =
    [MOUNTINFO_PATH, CONTROL_ROOT, "/usr/local/bin/sandbox-shim"];
const RESERVED_S3FS_OPTIONS: [&str; 28] = [
    "ahbe_conf",
    "allow_other",
    "compat_dir",
    "credlib",
    "ecs",
    "endpoint",
    "f",
    "fg",
    "foreground",
    "fsname",
    "host",
    "iam_role",
    "ibm_iam_auth",
    "logfile",
    "nomixupload",
    "noproxy",
    "passwd_file",
    "profile",
    "proxy",
    "proxy_cred_file",
    "public_bucket",
    "ro",
    "rw",
    "subtype",
    "use_path_request_style",
    "use_proxy",
    "use_session_token",
    "url",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ObservedConfiguration {
    pub(super) source: ObservedSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) key_prefix: Option<String>,
    pub(super) access: Access,
    pub(super) s3fs_options: Vec<S3fsOption>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum ObservedSource {
    S3 {
        endpoint: String,
        region: String,
        bucket: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Access {
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Marker {
    pub(super) protocol_version: u32,
    pub(super) route_id: String,
    pub(super) mount_path: String,
    pub(super) configuration: ObservedConfiguration,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MountRequest {
    pub(super) protocol_version: u32,
    pub(super) candidate_route_id: String,
    pub(super) mount_path: String,
    pub(super) configuration: ObservedConfiguration,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct S3fsOption {
    pub(super) name: String,
    pub(super) value: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum GuestMountState {
    Absent,
    Unmanaged { filesystem_type: String },
    Incompatible { protocol_version: u32 },
    Stale { marker: Marker },
    Managed { marker: Marker, fuse: FuseState },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(super) enum FuseState {
    Connected,
    Disconnected,
    Indeterminate { detail: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum RouteState {
    GatewayUnreachable {
        detail: String,
    },
    GatewayError {
        reason: GatewayErrorReason,
        detail: String,
    },
    Usable,
    UpstreamUnavailable {
        detail: String,
    },
    UpstreamRejected {
        reason: RejectionReason,
        detail: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum GatewayErrorReason {
    CredentialProvider,
    Protocol,
    Internal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum RejectionReason {
    Credentials,
    Access,
    NotFound,
    Other,
}

#[derive(Debug)]
pub(super) enum ControlError {
    Busy(String),
    Conflict(String),
    Failed(String),
    Incompatible(String),
    Protocol(String),
}

impl ControlError {
    pub(super) fn response(self) -> Value {
        let (kind, detail) = match self {
            Self::Busy(detail) => ("busy", detail),
            Self::Conflict(detail) => ("conflict", detail),
            Self::Failed(detail) => ("failed", detail),
            Self::Incompatible(detail) => ("incompatible", detail),
            Self::Protocol(detail) => ("protocol", detail),
        };
        json!({ "ok": false, "error": { "kind": kind, "detail": detail } })
    }
}

impl MountRequest {
    pub(super) fn parse(encoded: &str) -> Result<Self, ControlError> {
        let request: Self = serde_json::from_str(encoded)
            .map_err(|error| ControlError::Protocol(format!("invalid mount request: {error}")))?;
        validate_mount_target(&request.mount_path)?;
        if request.protocol_version != PROTOCOL_VERSION {
            return Err(ControlError::Incompatible(format!(
                "mount request protocol {} is not supported",
                request.protocol_version
            )));
        }
        validate_route_id(&request.candidate_route_id)?;
        validate_configuration(&request.configuration)?;
        Ok(request)
    }

    pub(super) fn into_marker(self, route_id: String) -> Marker {
        Marker {
            protocol_version: PROTOCOL_VERSION,
            route_id,
            mount_path: self.mount_path,
            configuration: self.configuration,
        }
    }
}

pub(super) fn validate_mount_path(path: &str) -> Result<(), ControlError> {
    if path.is_empty() || path.as_bytes().contains(&0) || !path.starts_with('/') {
        return Err(ControlError::Protocol(
            "mount path must be an absolute path without NUL bytes".into(),
        ));
    }
    if path == "/" || path.ends_with('/') || path.contains("//") {
        return Err(ControlError::Protocol(
            "mount path must be a normalized non-root path".into(),
        ));
    }
    if path
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(ControlError::Protocol(
            "mount path must not contain dot segments".into(),
        ));
    }
    Ok(())
}

fn validate_mount_target(path: &str) -> Result<(), ControlError> {
    validate_mount_path(path)?;
    if overlaps_reserved_guest_path(path) {
        return Err(ControlError::Protocol(
            "mount path overlaps sandbox control files".into(),
        ));
    }
    Ok(())
}

pub(super) fn overlaps_reserved_guest_path(path: &str) -> bool {
    RESERVED_GUEST_PATHS
        .iter()
        .any(|reserved| paths_overlap(path, reserved))
}

pub(super) fn paths_overlap(left: &str, right: &str) -> bool {
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub(super) fn validate_marker(marker: &Marker) -> Result<(), ControlError> {
    validate_route_id(&marker.route_id)?;
    validate_configuration(&marker.configuration)
}

fn validate_route_id(route_id: &str) -> Result<(), ControlError> {
    if route_id.is_empty()
        || route_id.len() > 60
        || !route_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || !route_id
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !route_id
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
        return Err(ControlError::Protocol("invalid mount route ID".into()));
    }
    Ok(())
}

fn validate_configuration(configuration: &ObservedConfiguration) -> Result<(), ControlError> {
    if let Some(prefix) = &configuration.key_prefix
        && (prefix.is_empty()
            || prefix.starts_with('/')
            || !prefix.ends_with('/')
            || prefix.contains('\0'))
    {
        return Err(ControlError::Protocol(
            "invalid canonical key prefix".into(),
        ));
    }
    let ObservedSource::S3 {
        endpoint,
        region,
        bucket,
    } = &configuration.source;
    if endpoint.is_empty()
        || endpoint.contains('\0')
        || region.is_empty()
        || region.contains('\0')
        || bucket.is_empty()
        || bucket.starts_with('-')
        || bucket.contains(['\0', '/', ':'])
    {
        return Err(ControlError::Protocol(
            "invalid S3 source configuration".into(),
        ));
    }
    for option in &configuration.s3fs_options {
        validate_s3fs_option(option)?;
    }
    Ok(())
}

fn validate_s3fs_option(option: &S3fsOption) -> Result<(), ControlError> {
    if option.name.is_empty()
        || option.name.contains(['\0', ',', '='])
        || option
            .value
            .as_deref()
            .is_some_and(|value| value.contains(['\0', ',']))
    {
        return Err(ControlError::Protocol("invalid s3fs option".into()));
    }
    if RESERVED_S3FS_OPTIONS
        .iter()
        .any(|reserved| option.name.eq_ignore_ascii_case(reserved))
    {
        return Err(ControlError::Protocol(format!(
            "s3fs option '{}' is reserved",
            option.name
        )));
    }
    Ok(())
}

pub(super) fn fsname(route_id: &str) -> String {
    format!("sandbox-s3-{route_id}")
}

pub(super) fn route_host(route_id: &str) -> String {
    format!("s3-{route_id}.sandbox.internal")
}

pub(super) fn effective_bucket(configuration: &ObservedConfiguration) -> &str {
    let ObservedSource::S3 { bucket, .. } = &configuration.source;
    bucket
}

pub(super) fn to_value<T: Serialize>(value: T) -> Result<Value, ControlError> {
    serde_json::to_value(value).map_err(|error| {
        ControlError::Protocol(format!("failed to encode command result: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s3fs_options_cannot_inject_sdk_owned_options() {
        let injected = S3fsOption {
            name: "custom".into(),
            value: Some("value,url=http://other".into()),
        };
        let reserved = S3fsOption {
            name: "FsNaMe".into(),
            value: Some("other".into()),
        };
        let always_on = S3fsOption {
            name: "nomixupload".into(),
            value: None,
        };

        assert!(matches!(
            validate_s3fs_option(&injected),
            Err(ControlError::Protocol(_))
        ));
        assert!(matches!(
            validate_s3fs_option(&reserved),
            Err(ControlError::Protocol(_))
        ));
        assert!(matches!(
            validate_s3fs_option(&always_on),
            Err(ControlError::Protocol(_))
        ));
    }

    #[test]
    fn rejects_mount_paths_that_overlap_control_files() {
        assert!(matches!(
            validate_mount_target("/run/sandbox"),
            Err(ControlError::Protocol(_))
        ));
        assert!(matches!(
            validate_mount_target("/run/sandbox/s3-mounts/nested"),
            Err(ControlError::Protocol(_))
        ));
        validate_mount_target("/workspace/data").unwrap();
        validate_mount_path("/run/sandbox").unwrap();
    }

    #[test]
    fn route_ids_are_dns_label_fragments() {
        validate_route_id("route-123").unwrap();
        assert!(validate_route_id("route-").is_err());
        assert!(validate_route_id("-route").is_err());
    }
}
