//! Moves the compressed archive between the container and the gateway: fixed-size parts up,
//! verified byte ranges down, several at a time, over plain HTTP/1.1 to the intercepted host.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::Failure;
use super::lifeline::Lifeline;

/// R2 requires every part but the last to have the same size.
pub(super) const PART_SIZE: usize = 16 * 1024 * 1024;
const MAX_PARALLEL: usize = 16;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_DETAIL_BYTES: usize = 4 * 1024;

/// Parts or ranges in flight at once: at most 16, and at most a quarter of available memory.
pub(super) fn parallelism() -> usize {
    let available = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("MemAvailable:"))
                .and_then(|value| {
                    value
                        .trim()
                        .trim_end_matches("kB")
                        .trim()
                        .parse::<u64>()
                        .ok()
                })
        })
        .map(|kib| kib.saturating_mul(1024));
    match available {
        Some(bytes) => ((bytes / 4 / PART_SIZE as u64) as usize).clamp(1, MAX_PARALLEL),
        None => 1,
    }
}

#[derive(Clone)]
pub(super) struct Gateway {
    host: String,
    address: SocketAddr,
    lifeline: Lifeline,
}

struct Response {
    status: u16,
    content_range: Option<String>,
    body: BodyReader,
}

impl Gateway {
    /// `authority` is `host` or `host:port`; the port defaults to 80.
    pub(super) fn resolve(authority: &str, lifeline: Lifeline) -> Result<Self, Failure> {
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (
                host,
                port.parse::<u16>()
                    .map_err(|_| Failure::Protocol("invalid gateway port".into()))?,
            ),
            None => (authority, 80),
        };
        let address = (host, port)
            .to_socket_addrs()
            .map_err(|error| {
                Failure::Transfer(format!("gateway host {host} did not resolve: {error}"))
            })?
            .next()
            .ok_or_else(|| Failure::Transfer(format!("gateway host {host} did not resolve")))?;
        Ok(Self {
            host: authority.to_owned(),
            address,
            lifeline,
        })
    }

    /// Uploads part `number` and returns its ETag.
    pub(super) fn put_part(&self, number: u32, body: &[u8]) -> Result<String, Failure> {
        let head = format!(
            "PUT /parts/{number} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\nUser-Agent: sandbox-shim/1\r\n\r\n",
            self.host,
            body.len()
        );
        let mut response = self.exchange(&head, body)?;
        if response.status != 200 {
            return Err(self.rejected(&mut response, "part upload"));
        }
        let body = self.read_bounded(&mut response.body, MAX_HEADER_BYTES)?;
        #[derive(serde::Deserialize)]
        struct Uploaded {
            etag: String,
        }
        serde_json::from_slice::<Uploaded>(&body)
            .map(|uploaded| uploaded.etag)
            .map_err(|_| Failure::Transfer("gateway returned an invalid part upload result".into()))
    }

    /// Downloads exactly `length` bytes at `offset` of an object that must be `total` bytes.
    pub(super) fn get_range(
        &self,
        offset: u64,
        length: u64,
        total: u64,
    ) -> Result<Vec<u8>, Failure> {
        let last = offset + length - 1;
        let head = format!(
            "GET /object HTTP/1.1\r\nHost: {}\r\nRange: bytes={offset}-{last}\r\nConnection: close\r\nUser-Agent: sandbox-shim/1\r\n\r\n",
            self.host
        );
        let mut response = self.exchange(&head, &[])?;
        match response.status {
            206 => {}
            404 => return Err(Failure::NotFound("the backup object does not exist".into())),
            416 => {
                return Err(Failure::Integrity(
                    "the backup object is shorter than the record".into(),
                ));
            }
            _ => return Err(self.rejected(&mut response, "range download")),
        }
        let expected = format!("bytes {offset}-{last}/{total}");
        if response.content_range.as_deref() != Some(expected.as_str()) {
            return Err(Failure::Integrity(format!(
                "range {offset}-{last} came back as {}",
                response
                    .content_range
                    .as_deref()
                    .unwrap_or("no Content-Range")
            )));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        (&mut response.body)
            .take(length + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| self.connection_failure(error))?;
        if bytes.len() as u64 != length {
            return Err(Failure::Integrity(format!(
                "range {offset}-{last} returned {} bytes",
                bytes.len()
            )));
        }
        Ok(bytes)
    }

    fn exchange(&self, head: &str, body: &[u8]) -> Result<Response, Failure> {
        if self.lifeline.aborted() {
            return Err(Failure::Aborted);
        }
        let stream =
            TcpStream::connect(self.address).map_err(|error| self.connection_failure(error))?;
        let guard = self.lifeline.register(&stream);
        (&stream)
            .write_all(head.as_bytes())
            .and_then(|()| (&stream).write_all(body))
            .map_err(|error| self.connection_failure(error))?;
        let mut reader = BufReader::with_capacity(256 * 1024, stream);
        let (status, headers) = read_head(&mut reader).map_err(|error| match error {
            HeadError::Io(error) => self.connection_failure(error),
            HeadError::Invalid(detail) => Failure::Transfer(detail),
        })?;
        let header = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        let chunked = header("transfer-encoding")
            .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
        let length = header("content-length").and_then(|value| value.parse::<u64>().ok());
        let body = BodyReader {
            inner: reader,
            framing: if chunked {
                Framing::Chunked {
                    remaining: 0,
                    done: false,
                }
            } else if let Some(length) = length {
                Framing::Length(length)
            } else {
                Framing::Close
            },
            _guard: guard,
        };
        Ok(Response {
            status,
            content_range: header("content-range"),
            body,
        })
    }

    fn rejected(&self, response: &mut Response, action: &str) -> Failure {
        let detail = self
            .read_bounded(&mut response.body, MAX_DETAIL_BYTES)
            .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned())
            .unwrap_or_default();
        let status = response.status;
        Failure::Transfer(if detail.is_empty() {
            format!("gateway rejected the {action} with HTTP {status}")
        } else {
            format!("gateway rejected the {action} with HTTP {status}: {detail}")
        })
    }

    fn read_bounded(&self, body: &mut BodyReader, limit: usize) -> Result<Vec<u8>, Failure> {
        let mut bytes = Vec::new();
        body.take(limit as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| self.connection_failure(error))?;
        Ok(bytes)
    }

    fn connection_failure(&self, error: io::Error) -> Failure {
        if self.lifeline.aborted() {
            Failure::Aborted
        } else {
            Failure::Transfer(format!("gateway connection failed: {error}"))
        }
    }
}

enum HeadError {
    Io(io::Error),
    Invalid(String),
}

fn read_head(reader: &mut impl BufRead) -> Result<(u16, Vec<(String, String)>), HeadError> {
    let mut head = Vec::new();
    loop {
        let before = head.len();
        reader
            .by_ref()
            .take((MAX_HEADER_BYTES - head.len()) as u64)
            .read_until(b'\n', &mut head)
            .map_err(HeadError::Io)?;
        if head.len() == before {
            return Err(HeadError::Invalid(
                "gateway closed the connection before responding".into(),
            ));
        }
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() >= MAX_HEADER_BYTES {
            return Err(HeadError::Invalid(
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
        .ok_or_else(|| HeadError::Invalid("gateway returned invalid HTTP".into()))?;
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

struct BodyReader {
    inner: BufReader<TcpStream>,
    framing: Framing,
    _guard: super::lifeline::SocketGuard,
}

impl Read for BodyReader {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadedPart {
    pub(super) part_number: u32,
    pub(super) etag: String,
}

pub(super) struct Uploaded {
    pub(super) size: u64,
    pub(super) sha256: String,
    pub(super) parts: Vec<UploadedPart>,
}

type PartSender = SyncSender<(u32, Vec<u8>)>;
type PartReceiver = Arc<Mutex<Receiver<(u32, Vec<u8>)>>>;

/// Takes the failure a background transfer recorded, so it can replace the generic I/O error
/// that reached the reader or writer.
pub(super) struct Failures(Box<dyn Fn() -> Option<Failure> + Send + Sync>);

impl Failures {
    pub(super) fn take(&self) -> Option<Failure> {
        (self.0)()
    }
}

/// Cuts the compressed stream into fixed-size parts, hashes it, and uploads parts in parallel.
pub(super) struct PartSink {
    part_size: usize,
    buffer: Vec<u8>,
    next_part: u32,
    size: u64,
    hasher: Sha256,
    sender: Option<PartSender>,
    workers: Vec<JoinHandle<()>>,
    shared: Arc<UploadShared>,
}

struct UploadShared {
    parts: Mutex<Vec<UploadedPart>>,
    failure: Mutex<Option<Failure>>,
    failed: AtomicBool,
}

impl PartSink {
    pub(super) fn new(
        upload: impl Fn(u32, &[u8]) -> Result<String, Failure> + Send + Sync + 'static,
        part_size: usize,
        parallel: usize,
    ) -> Self {
        let shared = Arc::new(UploadShared {
            parts: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
            failed: AtomicBool::new(false),
        });
        let (sender, receiver) = sync_channel::<(u32, Vec<u8>)>(0);
        let receiver = Arc::new(Mutex::new(receiver));
        let upload = Arc::new(upload);
        let workers = (0..parallel.max(1))
            .map(|_| {
                let receiver: PartReceiver = Arc::clone(&receiver);
                let shared = Arc::clone(&shared);
                let upload = Arc::clone(&upload);
                std::thread::spawn(move || {
                    loop {
                        let next = receiver
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .recv();
                        let Ok((number, body)) = next else { return };
                        if shared.failed.load(Ordering::SeqCst) {
                            continue;
                        }
                        match upload(number, &body) {
                            Ok(etag) => lock(&shared.parts).push(UploadedPart {
                                part_number: number,
                                etag,
                            }),
                            Err(failure) => {
                                lock(&shared.failure).get_or_insert(failure);
                                shared.failed.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                })
            })
            .collect();
        Self {
            part_size,
            buffer: Vec::with_capacity(part_size),
            next_part: 1,
            size: 0,
            hasher: Sha256::new(),
            sender: Some(sender),
            workers,
            shared,
        }
    }

    fn send(&mut self) -> io::Result<()> {
        let body = std::mem::replace(&mut self.buffer, Vec::with_capacity(self.part_size));
        let number = self.next_part;
        self.next_part += 1;
        let sent = self
            .sender
            .as_ref()
            .is_some_and(|sender| sender.send((number, body)).is_ok());
        if !sent || self.shared.failed.load(Ordering::SeqCst) {
            return Err(io::Error::other("part upload failed"));
        }
        Ok(())
    }

    /// Sends the last part, waits for every upload, and returns what the Durable Object needs to
    /// complete the upload. The last part is never empty unless the whole stream is.
    pub(super) fn finish(mut self) -> Result<Uploaded, Failure> {
        let flushed = if !self.buffer.is_empty() || self.next_part == 1 {
            self.send()
        } else {
            Ok(())
        };
        drop(self.sender.take());
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
        if let Some(failure) = lock(&self.shared.failure).take() {
            return Err(failure);
        }
        flushed.map_err(|error| Failure::Transfer(error.to_string()))?;
        let mut parts = std::mem::take(&mut *lock(&self.shared.parts));
        parts.sort_by_key(|part| part.part_number);
        Ok(Uploaded {
            size: self.size,
            sha256: hex(&self.hasher.clone().finalize()),
            parts,
        })
    }

    /// A handle to the failure that makes writes fail, if an upload causes it.
    pub(super) fn failures(&self) -> Failures {
        let shared = Arc::clone(&self.shared);
        Failures(Box::new(move || lock(&shared.failure).take()))
    }
}

impl Write for PartSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.shared.failed.load(Ordering::SeqCst) {
            return Err(io::Error::other("part upload failed"));
        }
        let count = bytes.len().min(self.part_size - self.buffer.len());
        self.buffer.extend_from_slice(&bytes[..count]);
        self.hasher.update(&bytes[..count]);
        self.size += count as u64;
        if self.buffer.len() == self.part_size {
            self.send()?;
        }
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for PartSink {
    fn drop(&mut self) {
        self.shared.failed.store(true, Ordering::SeqCst);
        drop(self.sender.take());
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

/// Reads the object as one ordered stream from ranges fetched in parallel, hashing and
/// counting the bytes it hands out.
pub(super) struct RangeReader {
    shared: Arc<RangeShared>,
    workers: Vec<JoinHandle<()>>,
    current: Vec<u8>,
    position: usize,
    next_index: u64,
    ranges: u64,
    count: u64,
    hasher: Sha256,
}

struct RangeShared {
    state: Mutex<RangeState>,
    changed: Condvar,
}

struct RangeState {
    next_to_fetch: u64,
    consumed: u64,
    ready: BTreeMap<u64, Vec<u8>>,
    failure: Option<Failure>,
    stopped: bool,
}

impl RangeReader {
    pub(super) fn new(
        fetch: impl Fn(u64, u64) -> Result<Vec<u8>, Failure> + Send + Sync + 'static,
        total: u64,
        range_size: u64,
        parallel: usize,
    ) -> Self {
        let ranges = total.div_ceil(range_size);
        let window = parallel.max(1) as u64;
        let shared = Arc::new(RangeShared {
            state: Mutex::new(RangeState {
                next_to_fetch: 0,
                consumed: 0,
                ready: BTreeMap::new(),
                failure: None,
                stopped: false,
            }),
            changed: Condvar::new(),
        });
        let fetch = Arc::new(fetch);
        let workers = (0..window)
            .map(|_| {
                let shared = Arc::clone(&shared);
                let fetch = Arc::clone(&fetch);
                std::thread::spawn(move || {
                    loop {
                        let index = {
                            let mut state = lock(&shared.state);
                            loop {
                                if state.stopped
                                    || state.failure.is_some()
                                    || state.next_to_fetch >= ranges
                                {
                                    return;
                                }
                                if state.next_to_fetch < state.consumed + window {
                                    break;
                                }
                                state = shared
                                    .changed
                                    .wait(state)
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                            }
                            state.next_to_fetch += 1;
                            state.next_to_fetch - 1
                        };
                        let offset = index * range_size;
                        let length = range_size.min(total - offset);
                        let result = fetch(offset, length);
                        let mut state = lock(&shared.state);
                        match result {
                            Ok(bytes) => {
                                state.ready.insert(index, bytes);
                            }
                            Err(failure) => {
                                state.failure.get_or_insert(failure);
                            }
                        }
                        shared.changed.notify_all();
                    }
                })
            })
            .collect();
        Self {
            shared,
            workers,
            current: Vec::new(),
            position: 0,
            next_index: 0,
            ranges,
            count: 0,
            hasher: Sha256::new(),
        }
    }

    /// A handle to the failure that ends the stream early, if a range causes it.
    pub(super) fn failures(&self) -> Failures {
        let shared = Arc::clone(&self.shared);
        Failures(Box::new(move || lock(&shared.state).failure.take()))
    }

    /// Returns the byte count and SHA-256 of everything read so far.
    pub(super) fn digest(&self) -> (u64, String) {
        (self.count, hex(&self.hasher.clone().finalize()))
    }

    pub(super) fn exhausted(&self) -> bool {
        self.next_index == self.ranges && self.position == self.current.len()
    }
}

impl Read for RangeReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.position == self.current.len() {
            if self.next_index == self.ranges {
                return Ok(0);
            }
            let mut state = lock(&self.shared.state);
            loop {
                if state.failure.is_some() {
                    return Err(io::Error::other("range download failed"));
                }
                if let Some(bytes) = state.ready.remove(&self.next_index) {
                    self.current = bytes;
                    self.position = 0;
                    self.next_index += 1;
                    state.consumed = self.next_index;
                    self.shared.changed.notify_all();
                    break;
                }
                state = self
                    .shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        let count = buffer.len().min(self.current.len() - self.position);
        let bytes = &self.current[self.position..self.position + count];
        buffer[..count].copy_from_slice(bytes);
        self.hasher.update(bytes);
        self.position += count;
        self.count += count as u64;
        Ok(count)
    }
}

impl Drop for RangeReader {
    fn drop(&mut self) {
        lock(&self.shared.state).stopped = true;
        self.shared.changed.notify_all();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    #[test]
    fn cuts_equal_parts_and_never_an_empty_last_part() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let mut sink = PartSink::new(
            move |number, body| {
                lock(&recorder).push((number, body.len()));
                Ok(format!("etag-{number}"))
            },
            4,
            3,
        );

        sink.write_all(b"abcdefgh").unwrap();
        let uploaded = sink.finish().unwrap();

        let mut seen = lock(&seen).clone();
        seen.sort();
        assert_eq!(seen, vec![(1, 4), (2, 4)]);
        assert_eq!(uploaded.size, 8);
        assert_eq!(uploaded.sha256, hex(&Sha256::digest(b"abcdefgh")));
        let numbers: Vec<_> = uploaded.parts.iter().map(|part| part.part_number).collect();
        assert_eq!(numbers, vec![1, 2]);
        assert_eq!(uploaded.parts[1].etag, "etag-2");
    }

    #[test]
    fn sends_a_short_last_part() {
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&sizes);
        let mut sink = PartSink::new(
            move |number, body| {
                lock(&recorder).push((number, body.len()));
                Ok(String::new())
            },
            4,
            1,
        );

        sink.write_all(b"abcdef").unwrap();
        sink.finish().unwrap();

        assert_eq!(*lock(&sizes), vec![(1, 4), (2, 2)]);
    }

    #[test]
    fn a_failed_part_fails_later_writes_and_the_upload() {
        let mut sink = PartSink::new(|_, _| Err(Failure::Transfer("rejected".into())), 2, 1);

        let written = sink.write_all(b"abcdefghij");
        let finished = sink.finish();

        assert!(written.is_err());
        assert!(matches!(finished, Err(Failure::Transfer(detail)) if detail == "rejected"));
    }

    #[test]
    fn reassembles_parallel_ranges_in_order() {
        let object: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        let source = object.clone();
        let calls = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&calls);
        let mut reader = RangeReader::new(
            move |offset, length| {
                counter.fetch_add(1, Ordering::SeqCst);
                // Later ranges finish first.
                std::thread::sleep(std::time::Duration::from_millis(20 - offset / 100));
                Ok(source[offset as usize..(offset + length) as usize].to_vec())
            },
            1000,
            100,
            4,
        );

        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();

        assert_eq!(bytes, object);
        assert!(reader.exhausted());
        assert_eq!(reader.digest(), (1000, hex(&Sha256::digest(&object))));
        assert_eq!(calls.load(Ordering::SeqCst), 10);
    }

    #[test]
    fn a_failed_range_ends_the_stream_with_its_failure() {
        let mut reader = RangeReader::new(
            |offset, length| {
                if offset == 0 {
                    Ok(vec![0; length as usize])
                } else {
                    Err(Failure::NotFound("gone".into()))
                }
            },
            30,
            10,
            2,
        );

        let mut bytes = Vec::new();
        assert!(reader.read_to_end(&mut bytes).is_err());
        assert!(matches!(
            reader.failures().take(),
            Some(Failure::NotFound(_))
        ));
    }
}
