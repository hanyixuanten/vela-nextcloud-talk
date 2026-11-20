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

  // Values that must survive a page switch (the keeper summary, the launch
  // gate's probe evidence) do NOT live here: this module is inlined into every
  // page bundle, so each page would get its own copy. They live on the app
  // instance instead — see common/scripts/shared.js.

}
