// AstroBox NG plugin: configure Nextcloud Talk credentials for the watch app.
//
// Why this plugin exists: typing a server URL and an app password on a 480px
// round screen is miserable. Here the user types them on the phone/desktop, the
// plugin pushes them over interconnect, and the watch app validates + persists
// them and answers with an ack.
//
// Flow:
//   on_load            enumerate devices, register interconnect recv, probe app
//   on_ui_render       render the form
//   on_ui_event_v3     collect field edits, or start a send
//   interconnect msg   ack from the watch -> update status
//   timer              no ack within 15s -> surface a timeout

mod logger;
mod protocol;
mod state;
mod ui;

use astrobox_ng_wit::FutureReader;
use astrobox_ng_wit::astrobox::psys_host::ui_v3::Event;
use astrobox_ng_wit::astrobox::psys_host::{device, interconnect, register, thirdpartyapp, timer};
use astrobox_ng_wit::exports::astrobox::psys_plugin::{event_v3, lifecycle};
use astrobox_ng_wit::wit_future;

use crate::state::Status;

const TIMEOUT_MS: u64 = 15_000;
const TIMEOUT_PAYLOAD: &str = "nctalk-send-timeout";

struct TalkCredentialPlugin;

/// Enumerate connected devices, subscribe to interconnect for the first one and
/// remember whether the watch app is installed. Returns the address we will push
/// to. Called from synchronous lifecycle code, so it drives the futures itself.
fn sync_refresh_device() -> Option<String> {
    astrobox_ng_wit::block_on(async {
        let devices = device::get_connected_device_list().await;
        let addr = devices.first().map(|d| d.addr.clone())?;

        if let Err(()) = register::register_interconnect_recv(&addr, protocol::PKG_NAME).await {
            tracing::warn!("register_interconnect_recv failed for {}", addr);
        }

        let installed = match thirdpartyapp::get_thirdparty_app_list(&addr).await {
            Ok(apps) => apps
                .iter()
                .any(|app| app.package_name == protocol::PKG_NAME),
            Err(()) => {
                tracing::warn!("get_thirdparty_app_list failed, skipping the install check");
                true
            }
        };

        state::with(|state| {
            state.addr = Some(addr.clone());
            state.app_installed = Some(installed);
        });

        Some(addr)
    })
}

/// Same as `sync_refresh_device`, usable from async context (spawned sends).
async fn refresh_device() -> Option<String> {
    let devices = device::get_connected_device_list().await;
    let addr = devices.first().map(|d| d.addr.clone())?;

    // Register again: on_load may have run before the watch was connected.
    if register::register_interconnect_recv(&addr, protocol::PKG_NAME)
        .await
        .is_err()
    {
        tracing::warn!("register_interconnect_recv failed for {}", addr);
    }

    state::with(|state| state.addr = Some(addr.clone()));
    Some(addr)
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

fn start_send() {
    let snapshot = state::snapshot();

    let server = snapshot.server.trim().to_string();
    let user = snapshot.user.trim().to_string();
    let password = snapshot.password.clone();

    if server.is_empty() || user.is_empty() || password.is_empty() {
        state::set_status(Status::Err("服务器、用户名、应用密码都要填。".to_string()));
        ui::render(&state::snapshot());
        return;
    }
    if !(server.starts_with("http://") || server.starts_with("https://")) {
        state::set_status(Status::Err(
            "服务器地址要以 http:// 或 https:// 开头。".to_string(),
        ));
        ui::render(&state::snapshot());
        return;
    }

    state::set_status(Status::Sending);
    ui::render(&state::snapshot());

    let payload = protocol::build_credential_message(&server, &user, &password);

    astrobox_ng_wit::spawn(async move {
        let addr = match refresh_device().await {
            Some(addr) => addr,
            None => {
                state::set_status(Status::Err(
                    "没有已连接的设备：先在 AstroBox 里连接手表。".to_string(),
                ));
                ui::render(&state::snapshot());
                return;
            }
        };

        if interconnect::send_qaic_message(&addr, protocol::PKG_NAME, &payload)
            .await
            .is_err()
        {
            state::set_status(Status::Err(
                "发送失败：手表拒绝了消息，确认 Talk 已经打开。".to_string(),
            ));
            ui::render(&state::snapshot());
            return;
        }

        // The watch answers asynchronously; reset the form only when it does.
        let _ = timer::set_timeout(TIMEOUT_MS, TIMEOUT_PAYLOAD).await;
    });
}

fn handle_ack(payload: &str) {
    let Some(ack) = protocol::parse_ack(payload) else {
        // Unrelated interconnect traffic on the same channel: ignore silently.
        return;
    };

    let status = if ack.ok {
        let name = if ack.display_name.is_empty() {
            String::new()
        } else {
            format!("（{}）", ack.display_name)
        };
        let message = if ack.message.is_empty() {
            format!("已保存到手表{}", name)
        } else {
            format!("{}{}", ack.message, name)
        };
        // Credentials are on the watch now; drop them from plugin memory.
        state::with(|state| {
            state.password.clear();
            state.status = Status::Ok(message);
        });
        ui::render(&state::snapshot());
        return;
    } else if ack.message.is_empty() {
        "手表配置失败".to_string()
    } else {
        ack.message
    };

    state::set_status(Status::Err(status));
    ui::render(&state::snapshot());
}

fn handle_timer(payload: &str) {
    if payload != TIMEOUT_PAYLOAD {
        return;
    }
    if state::snapshot().status == Status::Sending {
        state::set_status(Status::Err(
            "手表没有回应：确认 Talk 已打开并停在「从手机配置」页面。".to_string(),
        ));
        ui::render(&state::snapshot());
    }
}

impl lifecycle::Guest for TalkCredentialPlugin {
    fn on_load() {
        logger::init();
        tracing::info!("nctalk credential plugin loaded");

        match sync_refresh_device() {
            Some(addr) => tracing::info!("target device: {}", addr),
            None => tracing::warn!("no connected device at load time"),
        }
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

    fn on_ui_event_v3(
        event_id: String,
        event: Event,
        event_payload: String,
    ) -> FutureReader<String> {
        let (writer, reader) = wit_future::new::<String>(String::new);

        let value = parse_input_value(&event_payload);

        match event_id.as_str() {
            ui::EV_SERVER if matches!(event, Event::Input | Event::Change) => {
                state::with(|state| state.server = value);
                ui::render(&state::snapshot());
            }
            ui::EV_USER if matches!(event, Event::Input | Event::Change) => {
                state::with(|state| state.user = value);
                ui::render(&state::snapshot());
            }
            ui::EV_PASSWORD if matches!(event, Event::Input | Event::Change) => {
                state::with(|state| state.password = value);
                ui::render(&state::snapshot());
            }
            ui::EV_SEND if matches!(event, Event::Click) => start_send(),
            _ => {}
        }

        astrobox_ng_wit::spawn(async move {
            let _ = writer.write(String::new()).await;
        });

        reader
    }

    fn on_ui_render(element_id: String) -> FutureReader<()> {
        let (writer, reader) = wit_future::new::<()>(|| ());

        // Probe once so the form can warn about a missing app before sending.
        if state::snapshot().app_installed.is_none() {
            sync_refresh_device();
        }

        state::with(|state| state.element_id = Some(element_id));
        ui::render(&state::snapshot());

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
