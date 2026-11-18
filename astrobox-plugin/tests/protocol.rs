// Protocol tests, compiled for the host so they can actually run.
//
// The plugin itself is a wasm32-wasip2 component that pulls in wit-bindgen and
// cannot be built for the host, but src/protocol.rs is pure serde. Including it
// by path keeps a single copy of the protocol while still being testable:
//
//   cargo test --target x86_64-unknown-linux-gnu --test protocol

#[path = "../src/protocol.rs"]
#[allow(dead_code)]
mod protocol;

#[test]
fn builds_expected_json() {
    let raw = protocol::build_credential_message(" https://cloud.example.com/ ", " alice ", "app-pass");
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();

    assert_eq!(value["v"], 1);
    assert_eq!(value["kind"], "credentials");
    // Trailing slash trimmed, whitespace trimmed.
    assert_eq!(value["base_url"], "https://cloud.example.com");
    assert_eq!(value["user"], "alice");
    assert_eq!(value["app_password"], "app-pass");
}

#[test]
fn keeps_path_prefix_of_server_url() {
    let raw = protocol::build_credential_message("https://example.com/nextcloud/", "bob", "x");
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["base_url"], "https://example.com/nextcloud");
}

#[test]
fn parses_plain_ack() {
    let ack = protocol::parse_ack(r#"{"ok":true,"message":"已保存","display_name":"Alice"}"#).unwrap();
    assert!(ack.ok);
    assert_eq!(ack.message, "已保存");
    assert_eq!(ack.display_name, "Alice");
}

#[test]
fn parses_wrapped_ack() {
    let ack = protocol::parse_ack(r#"{"addr":"AA:BB","data":"{\"ok\":false,\"message\":\"密码错误\"}"}"#)
        .unwrap();
    assert!(!ack.ok);
    assert_eq!(ack.message, "密码错误");
}

#[test]
fn ack_defaults_are_lenient() {
    // The watch may omit optional fields; missing strings must not fail parsing.
    let ack = protocol::parse_ack(r#"{"ok":false}"#).unwrap();
    assert!(!ack.ok);
    assert_eq!(ack.message, "");
    assert_eq!(ack.display_name, "");
}

#[test]
fn ignores_json_without_ok_field() {
    assert!(protocol::parse_ack(r#"{"addr":"AA:BB"}"#).is_none());
}

#[test]
fn ignores_garbage() {
    assert!(protocol::parse_ack("not json").is_none());
    assert!(protocol::parse_ack("").is_none());
    assert!(protocol::parse_ack("[]").is_none());
}
