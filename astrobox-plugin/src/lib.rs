// AstroBox NG plugin: configure Nextcloud Talk credentials for the watch app.

mod logger;
mod protocol;
mod state;
mod ui;

use std::time::{SystemTime, UNIX_EPOCH};

use astrobox_ng_wit::FutureReader;
use astrobox_ng_wit::astrobox::psys_host::ui_v3::Event;
use astrobox_ng_wit::astrobox::psys_host::{device, interconnect, register, thirdpartyapp, timer};
use astrobox_ng_wit::exports::astrobox::psys_plugin::{event_v3, lifecycle};
use astrobox_ng_wit::wit_future;

use crate::state::{PendingSend, Status};

const TIMEOUT_MS: u64 = 15_000;

struct TalkCredentialPlugin;

async fn probe_device() {
    let devices = device::get_connected_device_list().await;
    let addr = match devices.as_slice() {
        [target] => Some(target.addr.clone()),
        _ => None,
    };
    let installed = if let Some(addr) = &addr {
        // Register when opening the form so newer hosts can notify the watch
        // that the phone side has connected before the user presses Send.
        if register::register_interconnect_recv(addr, protocol::PKG_NAME).await.is_err() {
            tracing::warn!("could not register Talk interconnect receiver during device probe");
        }
        thirdpartyapp::get_thirdparty_app_list(addr).await.ok().map(|apps| {
            apps.iter().any(|app| app.package_name == protocol::PKG_NAME)
        })
    } else {
        None
    };
    state::with(|state| {
        if state.pending.is_none() {
            state.addr = addr;
            state.multiple_devices = devices.len() > 1;
            state.app_installed = installed;
        }
    });
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
    state::with(|state| {
        if state.pending.is_some() {
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
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let id = format!("{}-{}", now.as_millis(), state.next_request);
        let payload = protocol::build_credential_message(server, user, &state.password, &id);
        state.pending = Some(PendingSend { id: id.clone(), addr: None });
        state.status = Status::Sending;
        Some((id, payload))
    })
}

fn fail_send(id: &str, message: &str) {
    let changed = state::with(|state| {
        if state.pending.as_ref().is_some_and(|pending| pending.id == id) {
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
    let devices = device::get_connected_device_list().await;
    let addr = match devices.as_slice() {
        [target] => Some(target.addr.clone()),
        _ => None,
    };
    state::with(|state| {
        if state.addr != addr {
            state.app_installed = None;
        }
        state.addr = addr.clone();
        state.multiple_devices = devices.len() > 1;
    });
    let Some(addr) = addr else {
        let message = if devices.is_empty() {
            "没有已连接的设备：先在 AstroBox 里连接手表。"
        } else {
            ui::MULTIPLE_DEVICES
        };
        fail_send(&id, message);
        return;
    };

    if register::register_interconnect_recv(&addr, protocol::PKG_NAME).await.is_err() {
        tracing::warn!("could not register Talk interconnect receiver");
        fail_send(&id, "无法订阅手表回复：请检查 AstroBox 的互联权限和设备连接。");
        return;
    }
    state::with(|state| {
        if let Some(pending) = state.pending.as_mut() {
            pending.addr = Some(addr.clone());
        }
    });
    if !state::with(|state| state.pending.as_ref().is_some_and(|pending| pending.id == id)) {
        return;
    }

    if interconnect::send_qaic_message(&addr, protocol::PKG_NAME, &payload).await.is_err() {
        tracing::warn!("could not submit Talk interconnect message");
        fail_send(&id, "无法发送：请检查互联权限、设备连接和手表是否已安装 Talk。");
        return;
    }
    state::with(|state| state.app_installed = Some(true));

    // Success from the host means the message was submitted, not that the
    // watch saved the credentials. The detached timeout waits for the ACK.
}

fn handle_ack(payload: &str) {
    let Some(received) = protocol::parse_ack(payload) else { return };
    let changed = state::with(|state| {
        let Some(pending) = state.pending.as_ref() else { return false };
        let Some(addr) = pending.addr.as_deref() else { return false };
        if !received.matches(addr, &pending.id) {
            return false;
        }
        let ack = received.ack;
        state.pending = None;
        state.status = if ack.ok {
            state.password.clear();
            let message = if ack.message.is_empty() { "已保存到手表" } else { &ack.message };
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
        state.pending.as_ref().filter(|pending| protocol::timeout_matches(payload, &pending.id))
            .map(|pending| pending.id.clone())
    });
    if let Some(id) = request_id {
        fail_send(&id, "手表没有回应：确认 Talk 已打开并停在「从手机配置」页面。");
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
            _ => {}
        }
        astrobox_ng_wit::spawn(async move {
            let _ = writer.write(String::new()).await;
        });
        reader
    }

    fn on_ui_event_v3(event_id: String, event: Event, event_payload: String) -> FutureReader<String> {
        let (writer, reader) = wit_future::new::<String>(String::new);
        // Finish the host-facing future only after the send and timer setup;
        // don't leave detached host work for the old runtime to drain.
        astrobox_ng_wit::spawn(async move {
            if event_id == ui::EV_SEND && matches!(event, Event::Click) {
                let send = begin_send();
                ui::render(&state::snapshot());
                if let Some((id, payload)) = send {
                    let timeout_id = id.clone();
                    let timeout_payload = protocol::timeout_payload(&timeout_id);
                    let timer_payload = timeout_payload.clone();
                    astrobox_ng_wit::spawn(async move {
                        let _ = timer::set_timeout(TIMEOUT_MS, &timer_payload).await;
                    });
                    start_send(id, payload).await;
                }
            } else if matches!(event, Event::Input | Event::Change) {
                let value = parse_input_value(&event_payload);
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
                    state::with(|state| state.status = Status::Idle);
                    ui::render(&state::snapshot());
                }
            }
            let _ = writer.write(String::new()).await;
        });
        reader
    }

    fn on_ui_render(element_id: String) -> FutureReader<()> {
        let (writer, reader) = wit_future::new::<()>(|| ());
        state::with(|state| state.element_id = Some(element_id));
        ui::render(&state::snapshot());
        astrobox_ng_wit::spawn(async move {
            probe_device().await;
            ui::render(&state::snapshot());
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
