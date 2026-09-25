//! The minimal HTTP/1.1 client the shim needs to reach Worker gateways on intercepted hosts: one
//! request per connection, `Connection: close`, and a response body that ends where its framing
//! says.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const USER_AGENT: &str = "sandbox-shim/1";

pub(crate) enum Error {
    /// The connection failed.
    Io(io::Error),
    /// The peer did not send a valid HTTP response head.
    Invalid(String),
}

pub(crate) struct Response {
    pub(crate) status: u16,
    headers: Vec<(String, String)>,
    pub(crate) body: Body,
}

impl Response {
    /// The first header named `name`, which must be lowercase.
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Sends one request on `stream` and reads the response head. `headers` are sent as given, after
/// `Host`; a non-empty `body` also gets its `Content-Length`.
pub(crate) fn request(
    stream: TcpStream,
    method: &str,
    target: &str,
    host: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<Response, Error> {
    let mut head = format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str(&format!(
        "Connection: close\r\nUser-Agent: {USER_AGENT}\r\n\r\n"
    ));
    (&stream)
        .write_all(head.as_bytes())
        .and_then(|()| (&stream).write_all(body))
        .map_err(Error::Io)?;

    let mut reader = BufReader::with_capacity(256 * 1024, stream);
    let (status, headers) = read_head(&mut reader)?;
    let mut response = Response {
        status,
        headers,
        body: Body {
            inner: reader,
            framing: Framing::Close,
        },
    };
    response.body.framing = if response
        .header("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        Framing::Chunked {
            remaining: 0,
            done: false,
        }
    } else if let Some(length) = response
        .header("content-length")
        .and_then(|value| value.parse().ok())
    {
        Framing::Length(length)
    } else {
        Framing::Close
    };
    Ok(response)
}

fn read_head(reader: &mut impl BufRead) -> Result<(u16, Vec<(String, String)>), Error> {
    let mut head = Vec::new();
    loop {
        let before = head.len();
        reader
            .by_ref()
            .take((MAX_HEADER_BYTES - head.len()) as u64)
            .read_until(b'\n', &mut head)
            .map_err(Error::Io)?;
        if head.len() == before {
            return Err(Error::Invalid(
                "gateway closed the connection before responding".into(),
            ));
        }
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() >= MAX_HEADER_BYTES {
            return Err(Error::Invalid(
                "gateway response headers were too large".into(),
            ));
        }
    }
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.strip_prefix("HTTP/1."))
        .and_then(|rest| rest.split(' ').nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| Error::Invalid("gateway returned invalid HTTP".into()))?;
    let headers = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Ok((status, headers))
}

enum Framing {
    Length(u64),
    Chunked { remaining: u64, done: bool },
    Close,
}

/// A response body that ends at its declared length, its last chunk, or the connection's end.
pub(crate) struct Body {
    inner: BufReader<TcpStream>,
    framing: Framing,
}

impl Read for Body {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match &mut self.framing {
            Framing::Close => self.inner.read(buffer),
            Framing::Length(remaining) => {
                if *remaining == 0 {
                    return Ok(0);
                }
                let limit = buffer.len().min(*remaining as usize);
                let count = self.inner.read(&mut buffer[..limit])?;
                if count == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                *remaining -= count as u64;
                Ok(count)
            }
            Framing::Chunked { remaining, done } => {
                if *done {
                    return Ok(0);
                }
                if *remaining == 0 {
                    let mut line = String::new();
                    self.inner.by_ref().take(1024).read_line(&mut line)?;
                    let size = line.trim().split(';').next().unwrap_or_default();
                    let size = u64::from_str_radix(size, 16).map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidData, "bad chunk size")
                    })?;
                    if size == 0 {
                        *done = true;
                        return Ok(0);
                    }
                    *remaining = size;
                }
                let limit = buffer.len().min(*remaining as usize);
                let count = self.inner.read(&mut buffer[..limit])?;
                if count == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                *remaining -= count as u64;
                if *remaining == 0 {
                    let mut crlf = [0u8; 2];
                    self.inner.read_exact(&mut crlf)?;
                }
                Ok(count)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Sends `reply` to one request and returns the response and what the server received.
    fn exchange(reply: &'static [u8], body: &[u8]) -> (Response, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            while !received.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                received.extend_from_slice(&buffer[..count]);
            }
            stream.write_all(reply).unwrap();
            String::from_utf8(received).unwrap()
        });
        let stream = TcpStream::connect(address).unwrap();
        let response = request(stream, "PUT", "/parts/1", "gateway", &[], body)
            .unwrap_or_else(|_| panic!("the request failed"));
        (response, server.join().unwrap())
    }

    fn body(response: &mut Response) -> io::Result<String> {
        let mut text = String::new();
        response.body.read_to_string(&mut text).map(|_| text)
    }

    #[test]
    fn sends_one_request_per_connection() {
        let (_, received) = exchange(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n", b"abc");

        assert!(received.starts_with("PUT /parts/1 HTTP/1.1\r\nHost: gateway\r\n"));
        assert!(received.contains("Content-Length: 3\r\n"));
        assert!(received.contains("Connection: close\r\n"));
    }

    #[test]
    fn reads_each_body_framing() {
        let (mut length, _) = exchange(
            b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-2/9\r\nContent-Length: 3\r\n\r\nabcIGNORED",
            b"",
        );
        let (mut chunked, _) = exchange(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;x=y\r\nabc\r\n2\r\nde\r\n0\r\n\r\n",
            b"",
        );
        let (mut close, _) = exchange(b"HTTP/1.1 502 Bad Gateway\r\n\r\nR2 failed", b"");

        assert_eq!(length.status, 206);
        assert_eq!(length.header("content-range"), Some("bytes 0-2/9"));
        assert_eq!(body(&mut length).unwrap(), "abc");
        assert_eq!(body(&mut chunked).unwrap(), "abcde");
        assert_eq!(close.status, 502);
        assert_eq!(body(&mut close).unwrap(), "R2 failed");
    }

    #[test]
    fn a_body_shorter_than_its_length_fails() {
        let (mut response, _) = exchange(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab", b"");

        assert_eq!(
            body(&mut response).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
