//! Stdin as the Durable Object's lifeline.
//!
//! The package writes one acknowledgement byte after it registers the operation's grant, then
//! keeps stdin open until the operation ends. The platform closes stdin as soon as the Durable
//! Object instance holding the process goes away, and sends nothing else: no signal, and writes
//! to stdout keep succeeding. So end of input, or any unexpected byte, before the package's
//! normal close means the operation has no owner, and the shim stops.

use std::collections::HashMap;
use std::io::Read;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

const ACKNOWLEDGEMENT: u8 = 1;

#[derive(Clone)]
pub(super) struct Lifeline {
    shared: Arc<Shared>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    aborted: AtomicBool,
    sockets: Mutex<HashMap<u64, TcpStream>>,
    next_socket: AtomicU64,
}

struct State {
    acknowledged: bool,
    closed: bool,
    /// While the main thread may be blocked where it can't look, such as in `flock`, a close
    /// ends the process directly. Nothing needs cleaning up at that point.
    exit_on_close: bool,
}

impl Lifeline {
    pub(super) fn start(input: impl Read + Send + 'static) -> Self {
        let lifeline = Self::detached();
        let reader = lifeline.clone();
        std::thread::spawn(move || reader.watch(input));
        lifeline
    }

    fn detached() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    acknowledged: false,
                    closed: false,
                    exit_on_close: true,
                }),
                changed: Condvar::new(),
                aborted: AtomicBool::new(false),
                sockets: Mutex::new(HashMap::new()),
                next_socket: AtomicU64::new(0),
            }),
        }
    }

    fn watch(&self, mut input: impl Read) {
        let mut byte = [0u8; 1];
        loop {
            let read = loop {
                match input.read(&mut byte) {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    other => break other,
                }
            };
            let mut state = self.lock();
            if matches!(read, Ok(1)) && byte[0] == ACKNOWLEDGEMENT && !state.acknowledged {
                state.acknowledged = true;
                self.shared.changed.notify_all();
                continue;
            }
            state.closed = true;
            if state.exit_on_close {
                std::process::exit(0);
            }
            self.abort();
            self.shared.changed.notify_all();
            return;
        }
    }

    /// Waits for the package's acknowledgement. From then on a close no longer exits the process:
    /// the main thread notices it and cleans up.
    pub(super) fn wait_for_acknowledgement(&self) -> bool {
        let mut state = self.lock();
        while !state.acknowledged && !state.closed {
            state = self.wait(state);
        }
        state.exit_on_close = false;
        !state.closed
    }

    /// Waits for the package to close stdin after the final frame. The package closes it only
    /// after it has replaced the grant, so the lock is held until then.
    pub(super) fn wait_for_close(&self) {
        let mut state = self.lock();
        state.exit_on_close = false;
        while !state.closed {
            state = self.wait(state);
        }
    }

    pub(super) fn aborted(&self) -> bool {
        self.shared.aborted.load(Ordering::SeqCst)
    }

    /// Tracks a connection so an abort can unblock a thread waiting on it.
    pub(super) fn register(&self, stream: &TcpStream) -> SocketGuard {
        let id = self.shared.next_socket.fetch_add(1, Ordering::Relaxed);
        if let Ok(clone) = stream.try_clone() {
            self.sockets().insert(id, clone);
        }
        if self.aborted() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        SocketGuard {
            lifeline: self.clone(),
            id,
        }
    }

    fn abort(&self) {
        self.shared.aborted.store(true, Ordering::SeqCst);
        for stream in self.sockets().values() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn sockets(&self) -> std::sync::MutexGuard<'_, HashMap<u64, TcpStream>> {
        self.shared
            .sockets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait<'a>(
        &self,
        guard: std::sync::MutexGuard<'a, State>,
    ) -> std::sync::MutexGuard<'a, State> {
        self.shared
            .changed
            .wait(guard)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub(super) struct SocketGuard {
    lifeline: Lifeline,
    id: u64,
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.lifeline.sockets().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_lifeline() -> Lifeline {
        let lifeline = Lifeline::detached();
        lifeline.lock().exit_on_close = false;
        lifeline
    }

    /// Stdin that yields what the test sends and ends when the sender is dropped.
    struct Channel(std::sync::mpsc::Receiver<u8>);

    impl Read for Channel {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            match self.0.recv() {
                Ok(byte) => {
                    buffer[0] = byte;
                    Ok(1)
                }
                Err(_) => Ok(0),
            }
        }
    }

    fn watched() -> (Lifeline, std::sync::mpsc::Sender<u8>) {
        let (sender, receiver) = std::sync::mpsc::channel();
        let lifeline = test_lifeline();
        let reader = lifeline.clone();
        std::thread::spawn(move || reader.watch(Channel(receiver)));
        (lifeline, sender)
    }

    #[test]
    fn a_close_after_the_acknowledgement_aborts() {
        let (lifeline, stdin) = watched();
        stdin.send(ACKNOWLEDGEMENT).unwrap();

        assert!(lifeline.wait_for_acknowledgement());
        assert!(!lifeline.aborted());
        drop(stdin);
        lifeline.wait_for_close();
        assert!(lifeline.aborted());
    }

    #[test]
    fn close_before_acknowledgement_is_reported() {
        let (lifeline, stdin) = watched();
        drop(stdin);

        assert!(!lifeline.wait_for_acknowledgement());
        assert!(lifeline.aborted());
    }

    #[test]
    fn an_unexpected_byte_counts_as_a_close() {
        let (lifeline, stdin) = watched();
        stdin.send(7).unwrap();

        assert!(!lifeline.wait_for_acknowledgement());
    }

    #[test]
    fn abort_shuts_down_registered_connections() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let _server = listener.accept().unwrap();
        let lifeline = test_lifeline();
        let _guard = lifeline.register(&client);

        lifeline.abort();

        let mut buffer = [0u8; 1];
        assert_eq!((&client).read(&mut buffer).unwrap(), 0);
    }
}
