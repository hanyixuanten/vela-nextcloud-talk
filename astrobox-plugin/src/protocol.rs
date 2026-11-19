// Message protocol between the AstroBox plugin and the Vela app.
// Keep the inner JSON in sync with src/common/scripts/protocol.js.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Package name of the watch app. Must match the watch manifest's `package`.
pub const PKG_NAME: &str = "com.hanyixuanten.nctalk";
pub const PROTOCOL_VERSION: u32 = 1;
const TIMEOUT_PREFIX: &str = "nctalk-send-timeout:";

#[derive(Serialize)]
struct CredentialMessage<'a> {
    v: u32,
    kind: &'a str,
    base_url: &'a str,
    user: &'a str,
    app_password: &'a str,
    request_id: &'a str,
}

pub fn normalize_server(server: &str) -> Option<String> {
    let trimmed = server.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") || rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if authority.starts_with('[') {
        authority.split_once(']').map(|(host, _)| host).unwrap_or("")
    } else {
        authority.rsplit_once(':').map_or(authority, |(host, port)| {
            if port.bytes().all(|byte| byte.is_ascii_digit()) { host } else { authority }
        })
    };
    if authority.is_empty() || host.is_empty() || host.starts_with(':') || authority.contains('@') || authority.chars().any(char::is_control) {
        return None;
    }
    let normalized = format!("https://{}", rest.trim_end_matches('/'));
    Some(normalized)
}

pub fn build_credential_message(server: &str, user: &str, password: &str, request_id: &str) -> String {
    let normalized_server = normalize_server(server).unwrap_or_default();
    let message = CredentialMessage {
        v: PROTOCOL_VERSION,
        kind: "credentials",
        base_url: normalized_server.as_str(),
        user: user.trim(),
        app_password: password,
        request_id,
    };
    // A struct containing only strings and a u32 always serializes to JSON.
    serde_json::to_string(&message).expect("credential message serialization")
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
        let source_matches = self.addr.as_deref().is_some_and(|from| normalize(from) == normalize(addr));
        let package_matches = self.pkg_name.as_deref().is_some_and(|pkg| pkg == PKG_NAME);
        let request_matches = self.ack.request_id.as_deref().is_some_and(|id| id == request_id);
        source_matches && package_matches && request_matches
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
