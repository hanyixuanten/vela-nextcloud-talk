// AstroBox NG plugin: configure Nextcloud Talk credentials for the watch app.

mod logger;
mod protocol;
mod state;
mod ui;

use std::time::{SystemTime, UNIX_EPOCH};

use astrobox_ng_wit::FutureReader;
use astrobox_ng_wit::astrobox::psys_host::ui_v3::Event;
use astrobox_ng_wit::astrobox::psys_host::{
    device, interconnect, os, register, thirdpartyapp, timer,
};
use astrobox_ng_wit::exports::astrobox::psys_plugin::{event_v3, lifecycle};
use astrobox_ng_wit::wit_future;

use crate::state::{PendingSend, Status};

const TIMEOUT_MS: u64 = 15_000;
/// How long after the ACK timeout a pending send is treated as dead. The host
/// timer can be lost (panel closed, runtime restarted), so the UI must not rely
/// on it alone.
const PENDING_GRACE_MS: u64 = 5_000;
/// Page that subscribes to interconnect on the watch. Launching straight into
/// it saves the user from walking 设置 → 从手机配置 every time.
const SETUP_PAGE: &str = "pages/setup";
const ENTRY_PAGE: &str = "pages/index";

struct TalkCredentialPlugin;

/// Which device the panel would push to, and why.
struct Target {
    addr: Option<String>,
    /// Name reported by the host for `addr`, so the panel can confirm visually
    /// which watch it is about to talk to.
    name: String,
    /// `addr` has an active transport (as opposed to merely being paired).
    connected: bool,
    /// Devices the host knows about; used to explain an empty connected list.
    known: usize,
    multiple: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn pending_is_stale(pending: &PendingSend) -> bool {
    now_ms().saturating_sub(pending.started_ms) > TIMEOUT_MS + PENDING_GRACE_MS
}

/// Never guess a target: more than one candidate is a hard stop. A single
/// *paired* device is accepted even when the host reports no active link,
/// because AstroBox can bring the transport up on send; the UI says so.
async fn resolve_target() -> Target {
    let connected = device::get_connected_device_list().await;
    if connected.len() == 1 {
        let device = &connected[0];
        return Target {
            addr: Some(device.addr.clone()),
            name: device.name.trim().to_string(),
            connected: true,
            known: 1,
            multiple: false,
        };
    }
    if connected.len() > 1 {
        return Target {
            addr: None,
            name: String::new(),
            connected: false,
            known: connected.len(),
            multiple: true,
        };
    }

    let known = device::get_device_list().await;
    Target {
        addr: if known.len() == 1 {
            Some(known[0].addr.clone())
        } else {
            None
        },
        name: if known.len() == 1 {
            known[0].name.trim().to_string()
        } else {
            String::new()
        },
        connected: false,
        known: known.len(),
        multiple: false,
    }
}

fn no_target_message(target: &Target) -> String {
    if target.multiple {
        return ui::MULTIPLE_DEVICES.to_string();
    }
    if target.known > 1 {
        return format!(
            "已配对的 {} 台设备都没有连接：只保留要配置的手表，再点「重新检测」。",
            target.known
        );
    }
    "没有已连接的设备：先在 AstroBox 里连接手表，再点「重新检测」。".to_string()
}

/// Open Talk on the watch, landing on the page that listens on interconnect.
/// The quick app only accepts interconnect traffic while that page is in front,
/// so this is the step that makes a send actually land.
async fn launch_talk(addr: &str) -> Result<(), String> {
    let apps = thirdpartyapp::get_thirdparty_app_list(addr)
        .await
        .map_err(|()| "无法读取手表上的应用列表，请检查设备连接".to_string())?;
    let app = apps
        .into_iter()
        .find(|app| app.package_name == protocol::PKG_NAME)
        .ok_or_else(|| "手表上没有安装 Talk（rpk），请先安装".to_string())?;

    if thirdpartyapp::launch_qa(addr, &app, SETUP_PAGE)
        .await
        .is_ok()
    {
        return Ok(());
    }
    // Older firmware may reject a non-entry page; fall back to the entry page.
    thirdpartyapp::launch_qa(addr, &app, ENTRY_PAGE)
        .await
        .map_err(|()| "无法启动手表上的 Talk".to_string())
}

/// Drops a pending send whose ACK can no longer arrive, so the form recovers
/// without closing the panel. Returns whether something was cleared.
fn clear_stale_pending() -> bool {
    let cleared = state::with(|state| {
        let stale = state.pending.as_ref().is_some_and(pending_is_stale);
        if stale {
            state.pending = None;
            state.status =
                Status::Err("上次发送没有收到手表回复，已重置，可以重新发送。".to_string());
        }
        stale
    });
    if cleared {
        tracing::warn!("cleared a pending send after the ACK timeout");
    }
    cleared
}

/// The host broadcasts connect/disconnect as `{action, addr, name}`. This is a
/// second, permission-free way to learn the address: `device` enumeration needs
/// an extra grant, while `thirdpartyapp` / `interconnect` do not.
fn handle_device_action(payload: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    let action = value.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let addr = value
        .get("addr")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if addr.is_empty() {
        return;
    }
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());

    match action {
        "connected" => {
            state::with(|state| {
                state.addr = Some(addr);
                state.link_connected = true;
                state.device_name = name.unwrap_or_default();
                state.probing = false;
            });
            tracing::info!("device connected event supplied the target address");
        }
        "disconnected" => {
            let cleared = state::with(|state| {
                if state.addr.as_deref() == Some(addr.as_str()) {
                    state.addr = None;
                    state.link_connected = false;
                    state.device_name.clear();
                    true
                } else {
                    false
                }
            });
            if !cleared {
                return;
            }
        }
        _ => return,
    }
    ui::render(&state::snapshot());
}

/// Ask the watch whether Talk is installed. Needs only the `thirdpartyapp`
/// grant, never `device`.
async fn check_installed(addr: &str) -> Option<bool> {
    thirdpartyapp::get_thirdparty_app_list(addr)
        .await
        .ok()
        .map(|apps| {
            apps.iter()
                .any(|app| app.package_name == protocol::PKG_NAME)
        })
}

/// Ask the host for the devices it can reach, then decide.
///
/// This is deliberately the *only* host work on the detection path, and it is
/// always driven by `block_on` from a callback -- never by `spawn`. wit-bindgen
/// documents that spawned tasks only run inside the async computation they were
/// spawned in; a task queued from a callback that returns immediately may simply
/// never be polled, in which case the plugin makes no host call at all: no
/// `device` permission request, no dialog, and a panel that sits on "no device"
/// forever. Both published plugins that work (BandTOTP, otp-helper) call
/// `block_on` inside the callback for exactly this reason.
async fn probe_device() {
    clear_stale_pending();
    // A typed address removes the need for `device` enumeration altogether:
    // that permission only exists to look the address up.
    let manual = state::with(|state| state.manual_addr.clone());
    if !manual.is_empty() {
        state::with(|state| {
            state.addr = Some(manual.clone());
            state.device_name.clear();
            state.link_connected = true;
            state.known_devices = 1;
            state.connected_devices = 1;
            state.multiple_devices = false;
            state.app_installed = None;
            state.probed = true;
            state.probing = false;
            state.probe_seq += 1;
        });
        ui::render(&state::snapshot());
        return;
    }
    let seq = state::with(|state| {
        state.probe_seq += 1;
        state.probing = true;
        state.probe_seq
    });
    ui::render(&state::snapshot());

    let target = resolve_target().await;

    // Commit the verdict the moment enumeration answers, and nothing later: the
    // verdict must never wait on the 12 s app-list call.
    let accepted = state::with(|state| {
        if state.probe_seq != seq {
            return false;
        }
        // Enumeration wins when it works. When it returns nothing (no grant, or
        // no record), keep an address that came from a device-action event:
        // that path needs no `device` permission.
        if target.addr.is_some() {
            if state.addr != target.addr {
                state.app_installed = None;
            }
            state.addr = target.addr;
            state.link_connected = target.connected;
            if !target.name.is_empty() {
                state.device_name = target.name;
            }
        } else if state.addr.is_none() {
            state.link_connected = false;
            state.device_name.clear();
        }
        state.known_devices = target.known;
        state.connected_devices = if target.connected { 1 } else { 0 };
        state.multiple_devices = target.multiple;
        state.probing = false;
        state.probed = true;
        true
    });
    if !accepted {
        // A newer probe already owns the panel; do not repaint over it.
        return;
    }
    ui::render(&state::snapshot());

    // With an empty device list the host version is the first thing worth
    // knowing: an AstroBox update can move or reset its device store.
    if state::with(|state| state.addr.is_none()) {
        fetch_host_info().await;
    }
}

/// Only queried when nothing was found, and only two cheap `os` calls, so it
/// runs inline instead of being deferred to a task that may never be polled.
async fn fetch_host_info() {
    let platform = os::platform().await;
    let version = os::version().await;
    let text = format!("{} {}", platform.trim(), version.trim())
        .trim()
        .to_string();
    if text.is_empty() {
        return;
    }
    let changed = state::with(|state| {
        if state.host == text {
            false
        } else {
            state.host = text;
            true
        }
    });
    if changed {
        ui::render(&state::snapshot());
    }
}

fn parse_input_value(payload: &str) -> String {
    // The host may send the raw value or a JSON object such as {"value":".."}.
    if payload.trim_start().starts_with('{') {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
            for key in ["value", "data", "text"] {
                if let Some(inner) = value.get(key).and_then(|v| v.as_str()) {
                    return inner.to_string();
                }
            }
        }
    }
    payload.to_string()
}

fn begin_send() -> Option<(String, String)> {
    clear_stale_pending();
    state::with(|state| {
        if state.pending.is_some() {
            state.status = Status::Err(
                "上一次发送还在等待手表回复，请稍候，或点「重新检测」重置。".to_string(),
            );
            return None;
        }
        let server = state.server.trim();
        let user = state.user.trim();
        if server.is_empty() || user.is_empty() || state.password.is_empty() {
            state.status = Status::Err("服务器、用户名、应用密码都要填。".to_string());
            return None;
        }
        if protocol::normalize_server(server).is_none() {
            state.status = Status::Err("请输入有效的 HTTPS 服务器地址。".to_string());
            return None;
        }

        state.next_request += 1;
        let id = format!("{}-{}", now_ms(), state.next_request);
        let payload = protocol::build_credential_message(server, user, &state.password, &id);
        state.pending = Some(PendingSend {
            id: id.clone(),
            addr: None,
            started_ms: now_ms(),
        });
        state.status = Status::Sending;
        Some((id, payload))
    })
}

fn fail_send(id: &str, message: &str) {
    let changed = state::with(|state| {
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            state.pending = None;
            state.status = Status::Err(message.to_string());
            true
        } else {
            false
        }
    });
    if changed {
        ui::render(&state::snapshot());
    }
}

async fn start_send(id: String, payload: String) {
    // The timeout is started from a detached task by the click handler, before
    // any host future here can stall.

    // Always enumerate again on click. Never guess a target for credentials
    // if more than one device is connected.
    let target = resolve_target().await;
    state::with(|state| {
        // Owns the target now: an older probe must not repaint over it.
        state.probe_seq += 1;
        if state.addr != target.addr {
            state.app_installed = None;
        }
        state.addr = target.addr.clone();
        state.link_connected = target.connected;
        state.known_devices = target.known;
        state.multiple_devices = target.multiple;
        state.probed = true;
        state.probing = false;
        if !target.name.is_empty() {
            state.device_name = target.name.clone();
        }
    });
    let addr = match target.addr.clone() {
        Some(addr) => addr,
        None => {
            fail_send(&id, &no_target_message(&target));
            return;
        }
    };

    match check_installed(&addr).await {
        Some(false) => {
            fail_send(&id, "手表上没有安装 Talk（rpk），请先安装后再发送。");
            return;
        }
        Some(true) => state::with(|state| state.app_installed = Some(true)),
        None => {}
    }

    if register::register_interconnect_recv(&addr, protocol::PKG_NAME)
        .await
        .is_err()
    {
        tracing::warn!("could not register Talk interconnect receiver");
        fail_send(
            &id,
            "无法订阅手表回复：请检查 AstroBox 的互联权限和设备连接。",
        );
        return;
    }
    state::with(|state| {
        if let Some(pending) = state.pending.as_mut() {
            pending.addr = Some(addr.clone());
        }
    });
    if !state::with(|state| {
        state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
    }) {
        return;
    }

    if interconnect::send_qaic_message(&addr, protocol::PKG_NAME, &payload)
        .await
        .is_err()
    {
        tracing::warn!("could not submit Talk interconnect message");
        fail_send(
            &id,
            if target.connected {
                "无法发送：请检查互联权限、设备连接和手表是否已安装 Talk。"
            } else {
                "设备当前未连接：先在 AstroBox 里连接手表，再点「重新检测」后发送。"
            },
        );
        return;
    }
    state::with(|state| state.app_installed = Some(true));

    // Success from the host means the message was submitted, not that the
    // watch saved the credentials. The detached timeout waits for the ACK.
}

fn handle_ack(payload: &str) {
    let Some(received) = protocol::parse_ack(payload) else {
        return;
    };
    let changed = state::with(|state| {
        let Some(pending) = state.pending.as_ref() else {
            return false;
        };
        let Some(addr) = pending.addr.as_deref() else {
            return false;
        };
        if !received.matches(addr, &pending.id) {
            return false;
        }
        let ack = received.ack;
        state.pending = None;
        state.link_connected = true;
        state.status = if ack.ok {
            state.password.clear();
            let message = if ack.message.is_empty() {
                "已保存到手表"
            } else {
                &ack.message
            };
            Status::Ok(if ack.display_name.is_empty() {
                message.to_string()
            } else {
                format!("{}（{}）", message, ack.display_name)
            })
        } else if ack.message.is_empty() {
            Status::Err("手表配置失败".to_string())
        } else {
            Status::Err(ack.message)
        };
        true
    });
    if changed {
        ui::render(&state::snapshot());
    }
}

fn handle_timer(payload: &str) {
    let request_id = state::with(|state| {
        state
            .pending
            .as_ref()
            .filter(|pending| protocol::timeout_matches(payload, &pending.id))
            .map(|pending| pending.id.clone())
    });
    if let Some(id) = request_id {
        fail_send(
            &id,
            "手表没有回应：确认 Talk 已打开并停在「从手机配置」页面。",
        );
    }
}

impl lifecycle::Guest for TalkCredentialPlugin {
    fn on_load() {
        logger::init();
        tracing::info!("nctalk credential plugin loaded");
    }
}

impl event_v3::Guest for TalkCredentialPlugin {
    fn on_event(event_type: event_v3::EventType, event_payload: String) -> FutureReader<String> {
        let (writer, reader) = wit_future::new::<String>(String::new);
        match event_type {
            event_v3::EventType::InterconnectMessage => handle_ack(&event_payload),
            event_v3::EventType::Timer => handle_timer(&event_payload),
            // The host reports connect/disconnect here. Without this the panel
            // keeps whatever it saw when it was first rendered, so a watch that
            // connects later still reads "no device" until the panel is reopened.
            event_v3::EventType::DeviceAction => {
                // Capture the address first: it arrives with the event and needs
                // no `device` permission, so it works even when enumeration is
                // denied.
                handle_device_action(&event_payload);
                // Run the probe blocking. A task queued with `spawn` from a sync
                // callback is not guaranteed to be polled at all, which shows up
                // as "the plugin never asked for the device permission".
                astrobox_ng_wit::block_on(async {
                    probe_device().await;
                    ui::render(&state::snapshot());
                });
            }
            _ => {}
        }
        // The returned future is resolved *after* this callback returns: the
        // host only receives its reader once we hand it back, so blocking on the
        // write here traps with "event loop cannot make further progress".
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write(String::new()).await;
        });
        reader
    }

    fn on_ui_event_v3(
        event_id: String,
        event: Event,
        event_payload: String,
    ) -> FutureReader<String> {
        let (writer, reader) = wit_future::new::<String>(String::new);
        // Run the work blocking -- this is what BandTOTP and otp-helper do, and
        // it is the only reliable way to make host calls from these callbacks.
        // The writer is deliberately *not* captured here: see below.
        let mut pending_write = Some(writer);
        astrobox_ng_wit::block_on(async {
            if event_id == ui::EV_SEND && matches!(event, Event::Click) {
                let send = begin_send();
                ui::render(&state::snapshot());
                if let Some((id, payload)) = send {
                    let timeout_payload = protocol::timeout_payload(&id);
                    let _ = timer::set_timeout(TIMEOUT_MS, &timeout_payload).await;
                    start_send(id, payload).await;
                }
            } else if event_id == ui::EV_REFRESH && matches!(event, Event::Click) {
                // Await the probe so the host future only resolves once the
                // fresh device list has been rendered.
                probe_device().await;
                ui::render(&state::snapshot());
            } else if event_id == ui::EV_LAUNCH && matches!(event, Event::Click) {
                let addr = state::with(|state| state.addr.clone());
                match addr {
                    Some(addr) => {
                        state::with(|state| {
                            state.status = Status::Ok("正在打开手表上的 Talk…".to_string())
                        });
                        ui::render(&state::snapshot());
                        let result = launch_talk(&addr).await;
                        state::with(|state| {
                            state.status = match result {
                                Ok(()) => {
                                    Status::Ok("已打开手表上的 Talk（从手机配置页）".to_string())
                                }
                                Err(message) => Status::Err(message),
                            };
                        });
                    }
                    None => state::with(|state| {
                        state.status = Status::Err("还没有可用设备：先点「重新检测」".to_string())
                    }),
                }
                ui::render(&state::snapshot());
            } else if event_id == ui::EV_MANUAL && matches!(event, Event::Input | Event::Change) {
                // Keep this synchronous: no host call per keystroke.
                let value = parse_input_value(&event_payload);
                let manual = value.trim().to_string();
                state::with(|state| {
                    state.manual_addr = manual.clone();
                    // Any in-flight probe must not overwrite what was typed.
                    state.probe_seq += 1;
                    state.app_installed = None;
                    if manual.is_empty() {
                        state.addr = None;
                        state.device_name.clear();
                        state.link_connected = false;
                        state.known_devices = 0;
                        state.connected_devices = 0;
                        state.probed = false;
                    } else {
                        state.addr = Some(manual);
                        state.device_name.clear();
                        state.link_connected = true;
                        state.known_devices = 1;
                        state.connected_devices = 1;
                        state.multiple_devices = false;
                        state.probed = true;
                        state.probing = false;
                    }
                });
                ui::render(&state::snapshot());
            } else if matches!(event, Event::Input | Event::Change) {
                let value = parse_input_value(&event_payload);
                let recovered = clear_stale_pending();
                let changed = state::with(|state| {
                    if state.pending.is_some() {
                        return false;
                    }
                    match event_id.as_str() {
                        ui::EV_SERVER => state.server = value,
                        ui::EV_USER => state.user = value,
                        ui::EV_PASSWORD => state.password = value,
                        _ => return false,
                    }
                    true
                });
                if changed {
                    // Keep the "reset" notice visible when the first keystroke
                    // is what recovered a stuck send.
                    if !recovered {
                        state::with(|state| state.status = Status::Idle);
                    }
                    ui::render(&state::snapshot());
                }
            }
        });
        astrobox_ng_wit::spawn(async move {
            if let Some(writer) = pending_write.take() {
                let _ = writer.write(String::new()).await;
            }
        });
        reader
    }

    fn on_ui_render(element_id: String) -> FutureReader<()> {
        let (writer, reader) = wit_future::new::<()>(|| ());
        state::with(|state| state.element_id = Some(element_id));
        // Paint only. Two reasons detection is user-triggered: both published
        // plugins that work (BandTOTP, otp-helper) read the device list from a
        // click handler, and a `device` permission prompt raised while the host
        // is still building the panel is the one case the frontend can answer
        // "not granted" -- after which the host returns an empty list, which
        // reads exactly like "no watch connected".
        ui::render(&state::snapshot());
        // Nothing to wait for, and blocking on the write would deadlock: the
        // host cannot read this future until the callback returns.
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write(()).await;
        });
        reader
    }

    fn on_card_render(_card_id: String) -> FutureReader<()> {
        let (writer, reader) = wit_future::new::<()>(|| ());
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write(()).await;
        });
        reader
    }
}

astrobox_ng_wit::export!(TalkCredentialPlugin);
