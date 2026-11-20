// Shared, process-wide runtime state.
//
// Vela bundles all pages into one JS runtime, so a module level object is a
// simple and sufficient cache: it is reused across page entries and reset when
// the app process is killed.
//
// Storage (store.js) remains the source of truth; this object only avoids
// re-reading it on every page switch.

export default {
  // Full settings object, see store.js for the shape.
  settings: null,

  // True once baseUrl/user/appPassword are all present.
  ready: false,

  // Conversation list cached by pages/index so pages/chat can show a title
  // immediately instead of flashing an empty header.
  rooms: [],

  // Conversation currently open in pages/chat: { token, name, ... }
  activeRoom: null,

  // Startup network gate (see common/scripts/network.js). Checked once per
  // process: a relaunch probes again, but returning from chat must not.
  online: true,
  networkChecked: false

}
