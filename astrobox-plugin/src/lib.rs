// AstroBox NG plugin (API Level 4): configure Nextcloud Talk credentials for
// the watch app.
//
// Level 4 exports are all `async func`, so every handler below can await host
// calls directly: no `block_on` inside sync callbacks, no `wit_future::new`
// + `spawn` write-back boilerplate, and no "a spawned task may never be
// polled" hazards -- the host runtime drives these tasks itself.

mod logger;
mod protocol;
mod state;
mod ui;

use std::time::{SystemTime, UNIX_EPOCH};

use astrobox_ng_wit::astrobox::psys_host_v4::ui::Event as UiEvent;
use astrobox_ng_wit::astrobox::psys_host_v4::{
    device, interconnect, os, register, thirdpartyapp, timer,
};
use astrobox_ng_wit::exports::astrobox::psys_plugin_v4::{event, lifecycle};

use crate::state::{PendingSend, Status};

/// How long the panel waits for the watch's ACK.
///
/// This budget must outlast everything the watch does between "message
/// received" and "ACK sent": its own OCS request has a 20 s watchdog
/// (`REQUEST_TIMEOUT_MS` in src/common/scripts/api.js), then it writes
/// @system.storage and only then replies. A shorter budget turns a working but
/// slow validation into "手表没有回应" on the phone while the watch is still
/// showing 正在校验账号…, which reads exactly like a failed handoff.
const TIMEOUT_MS: u64 = 40_000;
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
    let apps = thirdpartyapp::get_thirdparty_app_list(addr.to_string())
        .await
        .map_err(|reason| format!("无法读取手表上的应用列表（{reason}），请检查设备连接"))?;
    let app = apps
        .into_iter()
        .find(|app| app.package_name == protocol::PKG_NAME)
        .ok_or_else(|| "手表上没有安装 Talk（rpk），请先安装".to_string())?;

    if thirdpartyapp::launch_qa(addr.to_string(), app.clone(), SETUP_PAGE.to_string())
        .await
        .is_ok()
    {
        return Ok(());
    }
    // Older firmware may reject a non-entry page; fall back to the entry page.
    // Level 4 errors carry the host's reason, which is worth surfacing.
    thirdpartyapp::launch_qa(addr.to_string(), app, ENTRY_PAGE.to_string())
        .await
        .map_err(|reason| format!("无法启动手表上的 Talk：{reason}"))
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
    thirdpartyapp::get_thirdparty_app_list(addr.to_string())
        .await
        .ok()
        .map(|apps| {
            apps.iter()
                .any(|app| app.package_name == protocol::PKG_NAME)
        })
}

/// Ask the host for the devices it can reach, then decide.
///
/// Detection is the *only* host work on this path. Level 4 removed the old
/// Level 2/3 trap where a task queued from a sync callback might never be
/// polled: these handlers are async guest tasks the host drives itself.
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

/// Only queried when nothing was found, and only two cheap `os` calls.
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

    // The app list is *not* fetched before sending. `get_thirdparty_app_list`
    // carries a 12 s host timeout, and spending it here ate most of the ACK
    // budget before the watch had even received the credentials. It is only
    // used below to explain a send that already failed, where the extra wait
    // costs nothing that is still working.
    if let Err(reason) =
        register::register_interconnect_recv(addr.clone(), protocol::PKG_NAME.to_string()).await
    {
        tracing::warn!("could not register Talk interconnect receiver: {reason}");
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

    if let Err(reason) =
        interconnect::send_qaic_message(addr.clone(), protocol::PKG_NAME.to_string(), payload).await
    {
        tracing::warn!("could not submit Talk interconnect message: {reason}");
        // Now that the send has already failed, the app list is worth its
        // 12 s host timeout: it separates "rpk missing" from "transport down".
        if check_installed(&addr).await == Some(false) {
            state::with(|state| state.app_installed = Some(false));
            fail_send(&id, "手表上没有安装 Talk（rpk），请先安装后再发送。");
            return;
        }
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
    // watch saved the credentials. The timeout below waits for the ACK.
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
    async fn on_load() {
        logger::init();
        tracing::info!("nctalk credential plugin loaded (api level 4)");
    }
}

impl event::Guest for TalkCredentialPlugin {
    async fn on_event(event_type: event::EventType, event_payload: String) -> String {
        match event_type {
            event::EventType::InterconnectMessage => handle_ack(&event_payload),
            event::EventType::Timer => handle_timer(&event_payload),
            // The host reports connect/disconnect here. Without this the panel
            // keeps whatever it saw when it was first rendered, so a watch that
            // connects later still reads "no device" until the panel is reopened.
            event::EventType::DeviceAction => {
                // Capture the address first: it arrives with the event and needs
                // no `device` permission, so it works even when enumeration is
                // denied. Then probe while this async task is still running, so
                // the host sees a fresh device list by the time we return.
                handle_device_action(&event_payload);
                probe_device().await;
                ui::render(&state::snapshot());
            }
            _ => {}
        }
        String::new()
    }

    async fn on_ui_event(event_id: String, event: UiEvent, event_payload: String) -> String {
        if event_id == ui::EV_SEND && matches!(event, UiEvent::Click) {
            let send = begin_send();
            ui::render(&state::snapshot());
            if let Some((id, payload)) = send {
                let timeout_payload = protocol::timeout_payload(&id);
                // Level 4 timers are local operations that return immediately;
                // expiry arrives later as a timer event on on_event.
                timer::set_timeout(TIMEOUT_MS, &timeout_payload);
                start_send(id, payload).await;
            }
        } else if event_id == ui::EV_REFRESH && matches!(event, UiEvent::Click) {
            // Await the probe so the host only sees this task complete once the
            // fresh device list has been rendered.
            probe_device().await;
            ui::render(&state::snapshot());
        } else if event_id == ui::EV_LAUNCH && matches!(event, UiEvent::Click) {
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
                            Ok(()) => Status::Ok("已打开手表上的 Talk（从手机配置页）".to_string()),
                            Err(message) => Status::Err(message),
                        };
                    });
                }
                None => state::with(|state| {
                    state.status = Status::Err("还没有可用设备：先点「重新检测」".to_string())
                }),
            }
            ui::render(&state::snapshot());
        } else if event_id == ui::EV_MANUAL && matches!(event, UiEvent::Input | UiEvent::Change) {
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
        } else if matches!(event, UiEvent::Input | UiEvent::Change) {
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
        String::new()
    }

    async fn on_ui_render(element_id: String) {
        state::with(|state| state.element_id = Some(element_id));
        // Paint only. Two reasons detection is user-triggered: both published
        // plugins that work (BandTOTP, otp-helper) read the device list from a
        // click handler, and a `device` permission prompt raised while the host
        // is still building the panel is the one case the frontend can answer
        // "not granted" -- after which the host returns an empty list, which
        // reads exactly like "no watch connected".
        ui::render(&state::snapshot());
    }

    async fn on_card_render(_card_id: String) {}
}

astrobox_ng_wit::export!(TalkCredentialPlugin);
