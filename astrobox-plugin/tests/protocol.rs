// Compile the same protocol module for the native test target:
// cargo test --locked --target x86_64-unknown-linux-gnu --test protocol
#[path = "../src/protocol.rs"]
mod protocol;

use protocol::{PKG_NAME, normalize_server, parse_ack, timeout_matches, timeout_payload};
use serde_json::json;

#[test]
fn validates_and_normalizes_https_server_urls() {
    assert_eq!(normalize_server(" HTTPS://cloud.example.com/base/// ").as_deref(), Some("https://cloud.example.com/base"));
    assert_eq!(normalize_server("https://[::1]:8443/base").as_deref(), Some("https://[::1]:8443/base"));
    for invalid in ["http://cloud.example.com", "https://", "https:///path", "https://user@host", "https://host name", "https://host\n", "https://:8443", "https://[]"] {
        assert!(normalize_server(invalid).is_none(), "accepted {invalid:?}");
    }
}

#[test]
fn builds_v1_credentials_with_request_id() {
    let raw = protocol::build_credential_message(
        " https://cloud.example.com/nextcloud/ ", " alice ", " app-pass ", "123-1",
    );
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value, json!({
        "v": 1, "kind": "credentials", "base_url": "https://cloud.example.com/nextcloud",
        "user": "alice", "app_password": " app-pass ", "request_id": "123-1"
    }));
}

#[test]
fn reads_current_astrobox_ack_envelope_and_checks_routing() {
    let inner = json!({"ok":true,"message":"已保存","display_name":"Alice","request_id":"123-1"});
    let event = json!({
        "addr":"aa-bb-cc-dd-ee-ff", "pkgName":PKG_NAME,
        "payloadHex":"", "payloadText":inner.to_string()
    });
    let received = parse_ack(&event.to_string()).unwrap();
    assert!(received.ack.ok);
    assert_eq!(received.ack.message, "已保存");
    assert_eq!(received.ack.display_name, "Alice");
    assert!(received.matches("AA:BB:CC:DD:EE:FF", "123-1"));
    assert!(!received.matches("AA:BB:CC:DD:EE:FF", "123-2"));
    assert!(!received.matches("00:BB:CC:DD:EE:FF", "123-1"));

    let mut foreign = event;
    foreign["pkgName"] = json!("example.other.app");
    assert!(!parse_ack(&foreign.to_string()).unwrap().matches("AA:BB:CC:DD:EE:FF", "123-1"));
}

#[test]
fn accepts_legacy_and_string_encoded_ack() {
    let legacy = parse_ack(r#"{"ok":false}"#).unwrap();
    assert!(!legacy.matches("AA:BB", "123-1"));
    assert!(!legacy.ack.ok);
    assert_eq!(legacy.ack.message, "");
    assert_eq!(legacy.ack.display_name, "");
    assert!(legacy.ack.request_id.is_none());

    for event in [
        json!({"addr":"AA:BB","data":r#"{"ok":false,"message":"密码错误"}"#}),
        json!({"payload":{"ok":false,"message":"密码错误"}}),
        json!({"payloadText":json!(r#"{"ok":false,"message":"密码错误"}"#).to_string()}),
    ] {
        assert_eq!(parse_ack(&event.to_string()).unwrap().ack.message, "密码错误");
    }
}

#[test]
fn ignores_unrelated_and_malformed_events() {
    for event in [
        "", "[]", "not json", r#"{"addr":"AA:BB"}"#, r#"{"ok":"true"}"#,
        r#"{"ok":true,"request_id":42}"#, r#"{"addr":0,"payloadText":"{\"ok\":true}"}"#,
        r#"{"payloadText":"not json","ok":true}"#, r#"{"payloadHex":"ff","ok":true}"#,
    ] {
        assert!(parse_ack(event).is_none(), "accepted {event}");
    }
}

#[test]
fn only_current_request_timeout_is_accepted() {
    let payload = timeout_payload("123-2");
    let event = json!({"timerId":17,"kind":"timeout","payload":payload}).to_string();
    assert!(timeout_matches(&event, "123-2"));
    assert!(!timeout_matches(&event, "123-1"));
    assert!(timeout_matches(&payload, "123-2"));
    assert!(!timeout_matches("nctalk-send-timeout", "123-2"));
    let interval = json!({"timerId":17,"kind":"interval","payload":payload}).to_string();
    assert!(!timeout_matches(&interval, "123-2"));
}
