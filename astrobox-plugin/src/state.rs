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

#[derive(Debug, Clone)]
pub struct State {
    /// Element id AstroBox handed us in on_ui_render; needed to re-render.
    pub element_id: Option<String>,
    /// Device address we push to (first connected device).
    pub addr: Option<String>,
    /// None = not probed yet, Some(false) = Talk is not installed.
    pub app_installed: Option<bool>,
    pub server: String,
    pub user: String,
    pub password: String,
    pub status: Status,
}

impl Default for State {
    fn default() -> Self {
        Self {
            element_id: None,
            addr: None,
            app_installed: None,
            server: String::new(),
            user: String::new(),
            password: String::new(),
            status: Status::Idle,
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

pub fn set_status(status: Status) {
    with(|state| state.status = status);
}
