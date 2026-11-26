// Launch gate routing.
//
// HyperBilibili does this in `pages/app/entry/splash`: the entry page is a
// logo screen, it awaits `jumpcheck.NetworkCheck()` and only then replaces to
// the real entry (login/eula/main). The main pages are never built on a
// network failure, so nothing tappable exists to walk into.
//
// This project keeps the same shape with one addition: `pages/splash` asks
// `common/scripts/network.js` (interface type + `<baseUrl>/status.php` probe)
// instead of only `getType`, because a watch can be associated to Wi-Fi with
// nothing routable behind it.
//
// The decision itself is a pure function so tests can pin it without a watch
// runtime; the splash page only does the plumbing.

// Page keys, not custom paths — the same form HyperBilibili uses and the one
// the watch's router accepts (`uri: "pages/app/features/main"`). Custom `path`
// values were removed from manifest.json: with them the gate's
// `replace('/')` never landed on pages/index.
export const ROUTE = {
  splash: 'pages/splash',
  home: 'pages/index',
  setup: 'pages/setup',
  offline: 'pages/offline',
  login: 'pages/login',
  chat: 'pages/chat',
  // Full text of one message, opened from the chat bubble's 展开全文 line.
  message: 'pages/message',
  settings: 'pages/settings'
}

/**
 * Where the launch gate sends the app.
 * `online` is the verdict from network.checkSignal; `configured` decides between
 * first-run setup and the main screen, and never overrides the network verdict.
 * "Configured" covers both modes: an account with an app password, or a public
 * conversation joined as a guest — store.isConfigured() answers it.
 */
export function routeAfterGate(online, configured) {
  if (!online) return ROUTE.offline
  if (!configured) return ROUTE.setup
  return ROUTE.home
}

export default {
  ROUTE,
  routeAfterGate
}
