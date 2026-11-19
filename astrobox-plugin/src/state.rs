// Single mutable state shared by the ui / event callbacks.
//
// AstroBox calls into the plugin from different entry points (on_load,
// on_ui_event_v3, on_event) that can interleave with async work, so everything
// lives behind one mutex. `with` never nests: callers clone a snapshot first,
// then build UI from the snapshot, otherwise a re-render inside a lock would
// deadlock.

use std::sync::{Mutex, MutexGuard, OnceLock};

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Idle,
    Sending,
    Ok(String),
    Err(String),
}

#[derive(Clone)]
pub struct PendingSend {
    pub id: String,
    /// Set only when registration has succeeded and a send is about to start.
    pub addr: Option<String>,
    /// Wall-clock start, so a send whose ACK never arrives cannot wedge the UI.
    pub started_ms: u64,
}

#[derive(Clone)]
pub struct State {
    /// Element id AstroBox handed us in on_ui_render; needed to re-render.
    pub element_id: Option<String>,
    /// Device address we push to (only when exactly one device is connected).
    pub addr: Option<String>,
    pub multiple_devices: bool,
    /// The single device in `addr` has an active transport right now.
    pub link_connected: bool,
    /// Device name carried by the last device-action event, for display.
    pub device_name: String,
    /// Address typed by the user. When set, enumeration is skipped entirely:
    /// the `device` permission is only needed to *look up* the address.
    pub manual_addr: String,
    /// How many devices the host knows about (paired), connected or not.
    pub known_devices: usize,
    /// How many devices the host reported as connected during the last probe.
    pub connected_devices: usize,
    /// A probe is in flight; the panel shows progress instead of a verdict.
    pub probing: bool,
    /// At least one enumeration finished, so "no device" is a real verdict
    /// rather than "we have not looked yet".
    pub probed: bool,
    /// The host never answered the last probe (watchdog fired).
    pub probe_hung: bool,
    /// Monotonic probe id, so a stale watchdog cannot clear a newer probe.
    pub probe_seq: u64,
    /// Host platform + AstroBox version, shown only when no device is found.
    pub host: String,
    /// None = not probed yet, Some(false) = Talk is not installed.
    pub app_installed: Option<bool>,
    pub server: String,
    pub user: String,
    pub password: String,
    pub status: Status,
    pub pending: Option<PendingSend>,
    pub next_request: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            element_id: None,
            addr: None,
            multiple_devices: false,
            link_connected: false,
            device_name: String::new(),
            manual_addr: String::new(),
            known_devices: 0,
            connected_devices: 0,
            probing: false,
            probed: false,
            probe_hung: false,
            probe_seq: 0,
            host: String::new(),
            app_installed: None,
            server: String::new(),
            user: String::new(),
            password: String::new(),
            status: Status::Idle,
            pending: None,
            next_request: 0,
        }
    }
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

pub fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mutex = STATE.get_or_init(|| Mutex::new(State::default()));
    let mut guard: MutexGuard<State> = mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

pub fn snapshot() -> State {
    with(|state| state.clone())
}
