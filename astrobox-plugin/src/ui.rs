// Declarative UI for the credential form (ui-v3 element builder).

use astrobox_ng_wit::astrobox::psys_host::ui_v3::{self, Element, ElementType, Event};

use crate::state::{State, Status};

pub const EV_SERVER: &str = "field-server";
pub const EV_USER: &str = "field-user";
pub const EV_PASSWORD: &str = "field-password";
pub const EV_SEND: &str = "send";

const MUTED: &str = "#8A94A6";
const TEXT: &str = "#E8EEF5";
const BORDER: &str = "#2A3038";
const FIELD_BG: &str = "#14181D";
const ACCENT: &str = "#0082C9";

pub fn build(state: &State) -> Element {
    let mut form = Element::new(ElementType::Div, None)
        .flex()
        .flex_direction(ui_v3::FlexDirection::Column)
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

    form = form.child(field_label("服务器"));
    form = form.child(field(
        "https://cloud.example.com",
        &state.server,
        EV_SERVER,
        false,
    ));

    form = form.child(field_label("用户名"));
    form = form.child(field("用户名或邮箱", &state.user, EV_USER, false));

    form = form.child(field_label("应用密码"));
    form = form.child(field(
        "Nextcloud → 设置 → 安全 → 应用密码",
        &state.password,
        EV_PASSWORD,
        true,
    ));

    let send_disabled = matches!(state.status, Status::Sending) || state.addr.is_none();
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

    // Connection hints: which device we push to, and whether Talk is installed.
    if let Some(problem) = preflight_message(state) {
        form = form.child(Element::new(ElementType::P, Some(&problem)).size(12).text_color("#FF8A80"));
    }

    if let Some((text, color)) = status_line(&state.status) {
        form = form.child(Element::new(ElementType::P, Some(&text)).size(13).text_color(color));
    }

    form
}

fn field_label(text: &str) -> Element {
    Element::new(ElementType::P, Some(text)).size(12).text_color(MUTED)
}

fn field(placeholder: &str, value: &str, event_id: &str, secret: bool) -> Element {
    let mut element = Element::new(ElementType::Input, None)
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

    if secret {
        // Never echo the app password back into the UI unconditionally; the
        // host still needs the value to keep the field stateful, so mark it as
        // a password input instead of clearing it.
        element = element.prop("type", "password");
    }

    element
}

fn button_caption(status: &Status) -> &'static str {
    match status {
        Status::Sending => "正在发送…",
        _ => "发送到手表",
    }
}

fn preflight_message(state: &State) -> Option<String> {
    if state.addr.is_none() {
        return Some("没有已连接的设备：先在 AstroBox 里连接手表。".to_string());
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
        ui_v3::render(&id, build(state));
    }
}
