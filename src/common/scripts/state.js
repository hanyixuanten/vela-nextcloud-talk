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

  // Last conversation list the keeper service saw while the app was away
  // (see common/scripts/keeper.js). pages/index renders it before the network
  // answer arrives, so unread badges survive a cold start.
  backgroundSummary: null,

  // Startup network gate (see common/scripts/network.js and pages/splash).
  // The splash page is the router entry: it probes once per launch and only
  // then sets `launchAllowed`. Every main page (会话 / 设置 / 聊天) checks it,
  // so a launch that failed the probe cannot reach the main UI at all.
  online: true,
  networkChecked: false,
  launchAllowed: false,

  // Advisory probes from the launch gate, both `{ ok, status, code, detail,
  // timedOut, ms, url }` or null. Never gate entry (design.md §9); comparing
  // them tells "no usable internet" apart from "this host is unreachable".
  controlProbe: null,
  serverProbe: null

}
