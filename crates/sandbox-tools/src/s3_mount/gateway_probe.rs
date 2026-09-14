use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use super::model::{
    ControlError, GatewayErrorReason, Marker, RejectionReason, RouteState, effective_bucket,
    route_host,
};

const MAX_PROBE_HEADERS_BYTES: usize = 64 * 1024;
const PROBE_IO_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn probe(marker: &Marker) -> Result<RouteState, ControlError> {
    let host = route_host(&marker.route_id);
    let bucket = effective_bucket(&marker.configuration);
    let mut query = String::from("list-type=2&max-keys=1");
    if let Some(prefix) = &marker.configuration.key_prefix {
        query.push_str("&prefix=");
        query.push_str(&percent_encode(prefix.as_bytes()));
    }
    let target = format!("/{}?{query}", percent_encode(bucket.as_bytes()));

    let address = match (host.as_str(), 80).to_socket_addrs() {
        Ok(mut addresses) => match addresses.next() {
            Some(address) => address,
            None => return Ok(unreachable("gateway host did not resolve")),
        },
        Err(error) => {
            return Ok(unreachable(&format!(
                "gateway host did not resolve: {error}"
            )));
        }
    };
    let mut stream = match TcpStream::connect_timeout(&address, PROBE_IO_TIMEOUT) {
        Ok(stream) => stream,
        Err(error) => return Ok(unreachable(&format!("gateway connection failed: {error}"))),
    };
    if let Err(error) = stream.set_read_timeout(Some(PROBE_IO_TIMEOUT)) {
        return Ok(unreachable(&format!(
            "cannot configure gateway response timeout: {error}"
        )));
    }
    if let Err(error) = stream.set_write_timeout(Some(PROBE_IO_TIMEOUT)) {
        return Ok(unreachable(&format!(
            "cannot configure gateway request timeout: {error}"
        )));
    }
    let request = format!(
        "GET {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: sandbox-shim/1\r\n\r\n"
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return Ok(unreachable(&format!("gateway request failed: {error}")));
    }
    let mut headers = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let count = match stream.read(&mut chunk) {
            Ok(count) => count,
            Err(error) => return Ok(unreachable(&format!("gateway response failed: {error}"))),
        };
        if count == 0 {
            break;
        }
        headers.extend_from_slice(&chunk[..count]);
        if headers.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if headers.len() > MAX_PROBE_HEADERS_BYTES {
            return Ok(gateway_error(
                GatewayErrorReason::Protocol,
                "gateway response headers were too large",
            ));
        }
    }
    parse_headers(&headers)
}

fn parse_headers(headers: &[u8]) -> Result<RouteState, ControlError> {
    let Some(header_end) = headers.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Ok(gateway_error(
            GatewayErrorReason::Protocol,
            "gateway returned truncated HTTP headers",
        ));
    };
    let text = String::from_utf8_lossy(&headers[..header_end]);
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    if !status_line.starts_with("HTTP/1.") {
        return Ok(gateway_error(
            GatewayErrorReason::Protocol,
            "gateway returned invalid HTTP",
        ));
    }
    let mut result = None;
    let mut detail = None;
    let mut version = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Ok(gateway_error(
                GatewayErrorReason::Protocol,
                "gateway returned an invalid header",
            ));
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "x-sandbox-s3-gateway-version" => version = Some(value.trim()),
            "x-sandbox-s3-inspection-result" => result = Some(value.trim()),
            "x-sandbox-s3-inspection-detail" => detail = Some(value.trim()),
            _ => {}
        }
    }
    if version != Some("1") {
        return Ok(gateway_error(
            GatewayErrorReason::Protocol,
            "gateway diagnostic protocol is missing or incompatible",
        ));
    }
    let decoded_detail = detail
        .and_then(|value| percent_decode(value.as_bytes()).ok())
        .and_then(|value| String::from_utf8(value).ok())
        .unwrap_or_else(|| "no additional detail".into());
    Ok(match result {
        Some("usable") => RouteState::Usable,
        Some("unavailable") => RouteState::UpstreamUnavailable {
            detail: decoded_detail,
        },
        Some("rejected-credentials") => rejected(RejectionReason::Credentials, decoded_detail),
        Some("rejected-access") => rejected(RejectionReason::Access, decoded_detail),
        Some("rejected-not-found") => rejected(RejectionReason::NotFound, decoded_detail),
        Some("rejected-other") => rejected(RejectionReason::Other, decoded_detail),
        Some("gateway-credential-provider") => {
            gateway_error(GatewayErrorReason::CredentialProvider, &decoded_detail)
        }
        Some("gateway-protocol") => gateway_error(GatewayErrorReason::Protocol, &decoded_detail),
        Some("gateway-internal") => gateway_error(GatewayErrorReason::Internal, &decoded_detail),
        _ => gateway_error(
            GatewayErrorReason::Protocol,
            "gateway returned an unknown diagnostic result",
        ),
    })
}

fn rejected(reason: RejectionReason, detail: String) -> RouteState {
    RouteState::UpstreamRejected { reason, detail }
}

fn unreachable(detail: &str) -> RouteState {
    RouteState::GatewayUnreachable {
        detail: detail.into(),
    }
}

fn gateway_error(reason: GatewayErrorReason, detail: &str) -> RouteState {
    RouteState::GatewayError {
        reason,
        detail: detail.into(),
    }
}

fn percent_encode(bytes: &[u8]) -> String {
    let mut encoded = String::new();
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn percent_decode(bytes: &[u8]) -> Result<Vec<u8>, ()> {
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(());
            }
            let high = hex_value(bytes[index + 1]).ok_or(())?;
            let low = hex_value(bytes[index + 2]).ok_or(())?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    Ok(decoded)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gateway_diagnostic_headers() {
        let state = parse_headers(
            b"HTTP/1.1 403 Forbidden\r\nx-sandbox-s3-gateway-version: 1\r\nx-sandbox-s3-inspection-result: rejected-credentials\r\nx-sandbox-s3-inspection-detail: credentials%20were%20rejected\r\n\r\n",
        )
        .unwrap();

        assert!(matches!(
            state,
            RouteState::UpstreamRejected {
                reason: RejectionReason::Credentials,
                ..
            }
        ));
    }

    #[test]
    fn missing_gateway_diagnostic_version_is_classified() {
        let state = parse_headers(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").unwrap();
        assert!(matches!(
            state,
            RouteState::GatewayError {
                reason: GatewayErrorReason::Protocol,
                ..
            }
        ));
    }

    #[test]
    fn truncated_gateway_headers_are_classified() {
        let state = parse_headers(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n").unwrap();
        assert!(matches!(
            state,
            RouteState::GatewayError {
                reason: GatewayErrorReason::Protocol,
                ..
            }
        ));
    }
}
