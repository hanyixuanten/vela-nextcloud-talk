// Declarative UI for the credential form (psys-host-v4 ui element builder).

use astrobox_ng_wit::astrobox::psys_host_v4::ui::{self, Element, ElementType, Event};

use crate::state::{State, Status};

pub const EV_SERVER: &str = "field-server";
pub const EV_USER: &str = "field-user";
pub const EV_PASSWORD: &str = "field-password";
pub const EV_SEND: &str = "send";
/// Open Talk on the watch so its interconnect listener is actually attached.
pub const EV_LAUNCH: &str = "launch";
/// Re-enumerate devices. The host does not always emit a device event, and the
/// panel must be recoverable without being closed and reopened.
pub const EV_REFRESH: &str = "refresh";
/// Typed device address: the only path that needs no `device` grant at all.
pub const EV_MANUAL: &str = "manual-addr";

const MUTED: &str = "#8A94A6";
const TEXT: &str = "#E8EEF5";
const BORDER: &str = "#2A3038";
const FIELD_BG: &str = "#14181D";
const ACCENT: &str = "#0082C9";
pub const MULTIPLE_DEVICES: &str = "连接了多台设备：请断开其他设备，只保留要配置的手表。";

pub fn build(state: &State) -> Element {
    let mut form = Element::new(ElementType::Div, None)
        .flex()
        .flex_direction(ui::FlexDirection::Column)
        .width_full()
        .padding(16)
        .gap(10);

    form = form.child(
        Element::new(ElementType::P, Some("Nextcloud Talk 凭据"))
            .size(17)
            .text_color(TEXT),
    );
    form = form.child(
        Element::new(
            ElementType::P,
            Some("手表上先打开 Talk → 设置 → 从手机配置，再回到这里点发送。"),
        )
        .size(12)
        .text_color(MUTED),
    );

    let sending = matches!(state.status, Status::Sending);
    form = form.child(field_label("服务器"));
    form = form.child(field(
        "https://cloud.example.com",
        &state.server,
        EV_SERVER,
        sending,
    ));

    form = form.child(field_label("用户名"));
    form = form.child(field("用户名或邮箱", &state.user, EV_USER, sending));

    form = form.child(field_label("应用密码"));
    // Plain text on purpose: app passwords are long and easy to mistype, and
    // this form is on the user's own device. Masking here only hid typos.
    form = form.child(field(
        "Nextcloud → 设置 → 安全 → 应用密码",
        &state.password,
        EV_PASSWORD,
        sending,
    ));

    // Advanced escape hatch: when the host refuses to hand out its device list,
    // a typed address skips enumeration entirely (and the `device` grant).
    form = form.child(field_label("设备地址（高级，可留空）"));
    form = form.child(field(
        "留空=自动检测；填了直接用它",
        &state.manual_addr,
        EV_MANUAL,
        sending,
    ));

    // A click re-enumerates devices, including a watch connected after render.
    let send_disabled = matches!(state.status, Status::Sending);
    let mut button = Element::new(ElementType::Button, Some(button_caption(&state.status)))
        .width_full()
        .padding(12)
        .radius(8)
        .bg(if send_disabled { "#2A3038" } else { ACCENT })
        .text_color("#FFFFFF")
        .on(Event::Click, EV_SEND);
    if send_disabled {
        button = button.disabled();
    }
    form = form.child(button);

    // Same as the known-good TOTP plugin: open the quick app first, then send.
    // Talk only listens on interconnect while its setup page is in front.
    let mut launch = Element::new(ElementType::Button, Some("打开手表上的 Talk"))
        .width_full()
        .padding(8)
        .radius(8)
        .bg("#1F252C")
        .text_color(TEXT)
        .on(Event::Click, EV_LAUNCH);
    if send_disabled {
        launch = launch.disabled();
    }
    form = form.child(launch);

    // Always enabled, including while a send is waiting for the ACK: this is
    // the escape hatch when the device list or the pending send goes stale.
    // Before the first probe it is the primary action, because the `device`
    // lookup is deliberately user-triggered (a permission prompt raised while
    // the panel is still rendering is what used to leave the panel empty).
    let detected = state.addr.is_some() || state.probed;
    let detect_label = if detected {
        "重新检测设备"
    } else {
        "检测设备"
    };
    form = form.child(
        Element::new(ElementType::Button, Some(detect_label))
            .width_full()
            .padding(8)
            .radius(8)
            .bg(if detected { "#1F252C" } else { ACCENT })
            .text_color(if detected { MUTED } else { "#FFFFFF" })
            .on(Event::Click, EV_REFRESH),
    );

    // Connection hints: which device we push to, and whether Talk is installed.
    if let Some(problem) = preflight_message(state) {
        form = form.child(
            Element::new(ElementType::P, Some(&problem))
                .size(12)
                .text_color("#FF8A80"),
        );
    }

    // Which watch we will push to. Enumeration carries a name, so this shows up
    // without waiting for a device-action event; fall back to the address when
    // the host only knows that.
    if let Some(addr) = state.addr.as_deref() {
        let target = if state.device_name.is_empty() {
            format!("目标：{}", addr)
        } else {
            format!("目标：{}", state.device_name)
        };
        form = form.child(
            Element::new(ElementType::P, Some(&target))
                .size(11)
                .text_color(MUTED),
        );
    }

    // Only useful when nothing was found: tells an OS/host change apart from a
    // device that is simply not connected.
    if state.addr.is_none() && !state.host.is_empty() {
        let host = format!("系统：{}", state.host);
        form = form.child(
            Element::new(ElementType::P, Some(&host))
                .size(11)
                .text_color(MUTED),
        );
    }

    if let Some((text, color)) = status_line(&state.status) {
        form = form.child(
            Element::new(ElementType::P, Some(&text))
                .size(13)
                .text_color(color),
        );
    }

    form
}

fn field_label(text: &str) -> Element {
    Element::new(ElementType::P, Some(text))
        .size(12)
        .text_color(MUTED)
}

fn field(placeholder: &str, value: &str, event_id: &str, disabled: bool) -> Element {
    let input = Element::new(ElementType::Input, None)
        .prop("placeholder", placeholder)
        .prop("value", value)
        .width_full()
        .padding(10)
        .radius(8)
        .border(1, BORDER)
        .bg(FIELD_BG)
        .text_color(TEXT)
        .on(Event::Input, event_id)
        .on(Event::Change, event_id);
    if disabled { input.disabled() } else { input }
}

fn button_caption(status: &Status) -> &'static str {
    match status {
        Status::Sending => "正在发送…",
        _ => "发送到手表",
    }
}

fn preflight_message(state: &State) -> Option<String> {
    // Progress and watchdog verdicts outrank a stale error line: they explain
    // why the panel cannot see a device.
    if state.probing && state.addr.is_none() && !state.multiple_devices {
        return Some("正在检测设备…（一直停在这里说明宿主的设备枚举没有返回）".to_string());
    }
    if matches!(state.status, Status::Err(_)) {
        return None;
    }
    if state.multiple_devices {
        return Some(MULTIPLE_DEVICES.to_string());
    }
    // Nothing has been enumerated yet: say so, instead of claiming the host has
    // no device records. Detection is user-triggered on purpose, so the very
    // first click is what asks the host for the device list.
    if state.addr.is_none() && !state.probed {
        return Some("点「检测设备」查找已经连上的手表。".to_string());
    }
    if state.addr.is_none() {
        if state.known_devices > 1 {
            return Some(format!(
                "已配对的 {} 台设备都没有连接：只保留要配置的手表，再点「重新检测」。",
                state.known_devices
            ));
        }
        if state.known_devices == 0 && state.connected_devices == 0 {
            return Some(
                "宿主里没有任何设备记录（已连接 0 / 已配对 0）：先在 AstroBox 的「设备」页添加并连接手表；\
                 若那边明明有设备，就是本插件的「设备」权限没有开启。"
                    .to_string(),
            );
        }
        return Some(format!(
            "没有已连接的设备（宿主报告：已连接 {} / 已配对 {}）：在 AstroBox 里连接手表后点「重新检测」。",
            state.connected_devices, state.known_devices
        ));
    }
    if !state.link_connected {
        return Some(
            "设备已配对但当前未连接：发送时会尝试连接，失败请先在 AstroBox 里连接。".to_string(),
        );
    }
    if state.app_installed == Some(false) {
        return Some("这台设备上没找到 Talk 应用，请先安装 rpk。".to_string());
    }
    None
}

fn status_line(status: &Status) -> Option<(String, &'static str)> {
    match status {
        Status::Idle => None,
        Status::Sending => Some(("等待手表确认…".to_string(), MUTED)),
        Status::Ok(message) => Some((message.clone(), "#7BD88F")),
        Status::Err(message) => Some((message.clone(), "#FF8A80")),
    }
}

/// Re-render the current form if AstroBox has given us an element id.
pub fn render(state: &State) {
    if let Some(id) = state.element_id.clone() {
        ui::render(&id, build(state));
    }
}
