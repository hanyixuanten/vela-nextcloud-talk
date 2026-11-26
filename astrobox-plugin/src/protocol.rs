// Message protocol between the AstroBox plugin and the Vela app.
// Keep the inner JSON in sync with src/common/scripts/protocol.js.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Package name of the watch app. Must match the watch manifest's `package`.
pub const PKG_NAME: &str = "com.hanyixuanten.nctalk";
/// v2 adds `mode` and the public-conversation fields. The watch still accepts a
/// v1 message (account only), but a v1 message must not be what this build
/// sends: it cannot express the public mode at all.
pub const PROTOCOL_VERSION: u32 = 2;
pub const MODE_ACCOUNT: &str = "account";
pub const MODE_PUBLIC: &str = "public";
const TIMEOUT_PREFIX: &str = "nctalk-send-timeout:";
/// Longest branch of Talk's room token rule; the watch re-validates.
const MAX_TOKEN_LEN: usize = 30;
const MIN_TOKEN_LEN: usize = 4;

/// One message shape for both modes: the watch reads `mode` and ignores the
/// fields that belong to the other one, so an account message still carries
/// (empty) room keys and a public message still carries (empty) user keys.
#[derive(Serialize)]
struct CredentialMessage<'a> {
    v: u32,
    kind: &'a str,
    mode: &'a str,
    base_url: &'a str,
    user: &'a str,
    app_password: &'a str,
    room_link: &'a str,
    room_token: &'a str,
    room_password: &'a str,
    display_name: &'a str,
    request_id: &'a str,
}

fn ipv6_groups(part: &str) -> Option<usize> {
    if part.is_empty() { return Some(0); }
    let segments: Vec<&str> = part.split(':').collect();
    let mut groups = 0usize;
    for (index, segment) in segments.iter().enumerate() {
        if segment.is_empty() { return None; }
        if segment.contains('.') {
            if index + 1 != segments.len() { return None; }
            let octets: Vec<&str> = segment.split('.').collect();
            if octets.len() != 4 || octets.iter().any(|octet| octet.is_empty() || octet.len() > 3 || !octet.bytes().all(|byte| byte.is_ascii_digit()) || octet.parse::<u8>().is_err()) { return None; }
            groups += 2;
        } else {
            if segment.len() > 4 || !segment.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
            groups += 1;
        }
    }
    Some(groups)
}

fn valid_ipv6_literal(address: &str) -> bool {
    if address.is_empty() || address.contains(":::") || address.matches("::").count() > 1 { return false; }
    if let Some((left, right)) = address.split_once("::") {
        match (ipv6_groups(left), ipv6_groups(right)) {
            (Some(left), Some(right)) => left + right < 8,
            _ => false,
        }
    } else {
        ipv6_groups(address) == Some(8)
    }
}

pub fn normalize_server(server: &str) -> Option<String> {
    if server.chars().any(char::is_control) {
        return None;
    }
    let trimmed = server.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https")
        || rest.is_empty()
        || rest.chars().any(char::is_whitespace)
        || rest.contains('#')
        || rest.contains('?')
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if !authority.starts_with('[') && authority.ends_with(':') {
        return None;
    }
    let host = if authority.starts_with('[') {
        let (host, suffix) = authority.split_once(']')?;
        if host.len() <= 1
            || !(suffix.is_empty() || suffix.starts_with(':'))
            || suffix.starts_with(':') && suffix.len() == 1
        {
            return None;
        }
        let address = &host[1..];
        if !valid_ipv6_literal(address) {
            return None;
        }
        host
    } else {
        let host = authority.rsplit_once(':').map_or(authority, |(host, _)| host);
        if host.is_empty()
            || host.starts_with('.')
            || host.ends_with('.')
            || host.split('.').any(|label| label.is_empty())
            || host.chars().any(|ch| !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '.'))
            || host.split('.').any(|label| label.starts_with('-') || label.ends_with('-'))
            || host.len() > 253
            || host.split('.').any(|label| label.len() > 63)
        {
            return None;
        }
        host
    };
    if authority.is_empty() || host.is_empty() || host.starts_with(':') || authority.contains('@') {
        return None;
    }
    let port = if authority.starts_with('[') {
        authority.split_once(']')?.1.strip_prefix(':')
    } else {
        authority.rsplit_once(':').and_then(|(_, port)| (!port.is_empty()).then_some(port))
    };
    if let Some(port) = port {
        if !port.bytes().all(|byte| byte.is_ascii_digit()) || port.parse::<u16>().ok().filter(|p| *p > 0).is_none() {
            return None;
        }
    } else if authority.starts_with('[') && !authority.ends_with(']') {
        return None;
    }
    let normalized_rest = rest.trim_end_matches('/');
    if normalized_rest.is_empty() {
        return None;
    }
    let normalized = format!("https://{}", normalized_rest);
    Some(normalized)
}

pub fn build_credential_message(server: &str, user: &str, password: &str, request_id: &str) -> String {
    let normalized_server = normalize_server(server).unwrap_or_default();
    serialize(CredentialMessage {
        v: PROTOCOL_VERSION,
        kind: "credentials",
        mode: MODE_ACCOUNT,
        base_url: normalized_server.as_str(),
        user: user.trim(),
        app_password: password,
        room_link: "",
        room_token: "",
        room_password: "",
        display_name: "",
        request_id,
    })
}

/// Public conversation: the room link the user pasted, the optional password,
/// and the name the watch will show to the room.
///
/// The link is sent as-is (trimmed) instead of being split here: the watch owns
/// room-link parsing (`src/common/scripts/roomlink.js`), so there is exactly one
/// implementation of it, and its error text is what the user ends up reading.
/// `base_url` therefore stays empty in this mode.
pub fn build_public_message(
    room_link: &str,
    room_password: &str,
    display_name: &str,
    request_id: &str,
) -> String {
    serialize(CredentialMessage {
        v: PROTOCOL_VERSION,
        kind: "credentials",
        mode: MODE_PUBLIC,
        base_url: "",
        user: "",
        app_password: "",
        room_link: room_link.trim(),
        room_token: "",
        room_password,
        display_name: display_name.trim(),
        request_id,
    })
}

fn serialize(message: CredentialMessage<'_>) -> String {
    // A struct containing only strings and a u32 always serializes to JSON.
    serde_json::to_string(&message).expect("credential message serialization")
}

/// The same checks the watch will make, run before a send: the panel is where
/// the user can fix the input, and a round trip that ends in "聊天室链接无效"
/// costs 40 s of waiting for the timer.
pub fn validate_public_input(room_link: &str, display_name: &str) -> Result<(), String> {
    if display_name.trim().is_empty() {
        return Err("请填写显示名称：聊天室里看不到用户名，只有这个名字。".to_string());
    }
    let link = room_link.trim();
    if link.is_empty() {
        return Err("请粘贴聊天室链接，或填想进的房间令牌。".to_string());
    }
    if link.contains("://") {
        // Validation only looks at the link without its query: `?password=` is
        // legitimate and `normalize_server` rejects any `?` outright.
        let head = link.split('?').next().unwrap_or(link);
        if normalize_server(head).is_none() {
            return Err("聊天室链接无效：应形如 https://服务器/call/令牌。".to_string());
        }
        return Ok(());
    }
    // The watch lower-cases the token before validating, so `ABC123` is fine.
    if !valid_token(&link.to_ascii_lowercase()) {
        return Err(format!(
            "聊天室令牌无效：{MIN_TOKEN_LEN}–{MAX_TOKEN_LEN} 位小写字母或数字。"
        ));
    }
    Ok(())
}

pub fn valid_token(token: &str) -> bool {
    let len = token.len();
    (MIN_TOKEN_LEN..=MAX_TOKEN_LEN).contains(&len)
        && token
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

#[derive(Debug, Deserialize)]
pub struct Ack {
    pub ok: bool,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug)]
pub struct ReceivedAck {
    addr: Option<String>,
    pkg_name: Option<String>,
    pub ack: Ack,
}

impl ReceivedAck {
    pub fn matches(&self, addr: &str, request_id: &str) -> bool {
        let normalize = |value: &str| value.trim().replace('-', ":").to_ascii_uppercase();
        // `request_id` is the only field that is *ours*: the watch echoes the id
        // this plugin generated, so it cannot be forged by another app's ACK and
        // cannot arrive late from an older send. Routing metadata is optional
        // (older hosts deliver a bare payload), so it may veto a match but never
        // be required: demanding `addr` meant a valid "已保存" arrived, was
        // dropped, and the panel reported "手表没有回应" 15 s later.
        let request_matches = self.ack.request_id.as_deref() == Some(request_id);
        if !request_matches {
            return false;
        }
        let source_matches = match self.addr.as_deref() {
            Some(from) => normalize(from) == normalize(addr),
            None => true,
        };
        let package_matches = match self.pkg_name.as_deref() {
            Some(pkg) => pkg == PKG_NAME,
            None => true,
        };
        source_matches && package_matches
    }
}

/// Current AstroBox emits {addr, pkgName, payloadHex, payloadText}. Preserve
/// its routing metadata, and accept older bare or one-level wrapped ACKs.
pub fn parse_ack(raw: &str) -> Option<ReceivedAck> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;
    let addr = obj.get("addr").map(read_string).transpose().ok()?;
    let pkg_name = obj.get("pkgName").map(read_string).transpose().ok()?;

    let ack = if let Some(inner) = obj.get("payloadText") {
        // The official envelope uses UTF-8 text for JSON. Don't reinterpret
        // envelope fields as an ACK when the actual payload doesn't parse.
        parse_inner_ack(inner)?
    } else if obj.contains_key("payloadHex") {
        return None;
    } else if obj.contains_key("ok") {
        serde_json::from_value(value).ok()?
    } else {
        ["data", "payload", "message"]
            .into_iter()
            .filter_map(|key| obj.get(key))
            .find_map(parse_inner_ack)?
    };

    Some(ReceivedAck { addr, pkg_name, ack })
}

fn read_string(value: &Value) -> Result<String, ()> {
    value.as_str().map(str::to_owned).ok_or(())
}

fn parse_inner_ack(value: &Value) -> Option<Ack> {
    // The watch normally sends an object. Some clients send JSON as a
    // string value, which can give us one more JSON string encoding.
    let decoded = match value {
        Value::String(text) => match serde_json::from_str(text).ok()? {
            Value::String(inner) => serde_json::from_str(&inner).ok()?,
            other => other,
        },
        other => other.clone(),
    };
    decoded.as_object()?;
    serde_json::from_value(decoded).ok()
}

pub fn timeout_payload(request_id: &str) -> String {
    format!("{TIMEOUT_PREFIX}{request_id}")
}

/// Current host wraps timer payloads; older hosts may return the bare marker.
pub fn timeout_matches(event_payload: &str, request_id: &str) -> bool {
    let expected = timeout_payload(request_id);
    if event_payload == expected {
        return true;
    }
    serde_json::from_str::<Value>(event_payload).is_ok_and(|value| {
        value.get("timerId").and_then(Value::as_u64).is_some()
            && value.get("kind").and_then(Value::as_str) == Some("timeout")
            && value.get("payload").and_then(Value::as_str) == Some(expected.as_str())
    })
}
