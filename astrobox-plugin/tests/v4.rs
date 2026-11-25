// Static contract for the API Level 4 migration.
//
// The plugin itself can only be built for wasm, but the manifest and the
// exported handler shapes are plain text. These assertions catch a silent
// fallback to the Level 2/3 world (`future<T>`, `event_v3`, WASI p2 manifest),
// which otherwise shows up only as a plugin that refuses to install/load.

fn code_without_line_comments(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn manifest_declares_the_level_4_runtime() {
    let manifest = include_str!("../manifest.json");
    assert!(
        manifest.contains("\"api_level\": 4"),
        "manifest must select the Level 4 runtime"
    );
    assert!(
        manifest.contains("\"wasi_version\": 3"),
        "Level 4 declares WASI Preview 3"
    );
    assert!(
        manifest.contains("\"entry\": \"nctalk_credential.wasm\""),
        "entry must match the cdylib name in Cargo.toml"
    );
}

#[test]
fn cargo_uses_the_v4_wit_world() {
    let cargo = include_str!("../Cargo.toml");
    assert!(
        cargo.contains("astrobox-ng-wit = \"0.4\""),
        "the v4 world lives in astrobox-ng-wit 0.4"
    );
    let cargo_config = include_str!("../.cargo/config.toml");
    assert!(
        cargo_config.contains("target = \"wasm32-wasip2\""),
        "std still links through WASI p2; the host provides p2 alongside p3"
    );
}

#[test]
fn exports_are_async_and_use_the_v4_interfaces() {
    let lib = code_without_line_comments(include_str!("../src/lib.rs"));
    for required in [
        "astrobox::psys_host_v4::ui",
        "astrobox::psys_host_v4::",
        "astrobox::psys_plugin_v4::",
        "async fn on_load()",
        "async fn on_event(",
        "async fn on_ui_event(",
        "async fn on_ui_render(",
        "astrobox_ng_wit::export!",
    ] {
        assert!(lib.contains(required), "missing v4 contract: {required}");
    }
    for legacy in [
        "astrobox::psys_host::",
        "psys_plugin::",
        "event_v3",
        "wit_future",
        "FutureReader",
        "astrobox_ng_wit::block_on",
        "astrobox_ng_wit::spawn",
    ] {
        assert!(
            !lib.contains(legacy),
            "Level 2/3 construct survived the migration: {legacy}"
        );
    }

    let ui = code_without_line_comments(include_str!("../src/ui.rs"));
    assert!(
        ui.contains("astrobox::psys_host_v4::ui"),
        "the declarative UI must come from the v4 world"
    );
}
