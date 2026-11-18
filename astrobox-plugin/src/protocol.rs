// Message protocol between the AstroBox plugin (host side) and the Vela app.
//
// Keep this file and src/common/scripts/protocol.js in the watch project in
// sync: the plugin writes CredentialMessage, the watch app answers with Ack.

use serde::{Deserialize, Serialize};

/// Package name of the watch app. Must match manifest.json's `package`.
pub const PKG_NAME: &str = "com.hanyixuanten.nctalk";

/// Bumped on breaking changes; the watch app rejects unknown versions instead
/// of half-parsing them.
pub const PROTOCOL_VERSION: u32 = 1;

/// Payload sent to the watch.
#[derive(Debug, Serialize)]
pub struct CredentialMessage<'a> {
    pub v: u32,
    pub kind: &'a str,
    pub base_url: &'a str,
    pub user: &'a str,
    pub app_password: &'a str,
}

pub fn build_credential_message(server: &str, user: &str, password: &str) -> String {
    let message = CredentialMessage {
        v: PROTOCOL_VERSION,
        kind: "credentials",
        base_url: server.trim().trim_end_matches('/'),
        user: user.trim(),
        app_password: password,
    };

    // Serialising a struct of &str cannot fail, but stay defensive: a panic here
    // would take down the whole plugin instance.
    serde_json::to_string(&message).unwrap_or_else(|_| "{}".to_string())
}

/// Acknowledgement sent back by the watch app.
#[derive(Debug, Default, Deserialize)]
pub struct Ack {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub display_name: String,
}

/// Host event payloads are stringly typed and may be wrapped one level deep
/// (for example `{"addr":"..","data":"{...}"}`). Try the plain form first, then
/// look inside the usual wrapper keys.
pub fn parse_ack(raw: &str) -> Option<Ack> {
    if let Some(ack) = try_ack(raw) {
        return Some(ack);
    }

    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    for key in ["data", "payload", "message"] {
        if let Some(inner) = value.get(key).and_then(|v| v.as_str()) {
            if let Some(ack) = try_ack(inner) {
                return Some(ack);
            }
        }
    }

    None
}

fn try_ack(raw: &str) -> Option<Ack> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;

    // Require the `ok` field, otherwise any JSON object would look like an ack
    // and errors from unrelated payloads would be swallowed as "failed".
    value.get("ok")?;

    serde_json::from_value(value).ok()
}
