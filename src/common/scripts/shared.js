// Cross-page runtime state.
//
// Vela bundles every page as its own webpack entry. A module-level object in
// `common/scripts/*.js` is therefore a PER-PAGE copy: a flag written on the
// splash page is invisible to `pages/index`, which is exactly how the launch
// gate ended up bouncing between 「检查网络…」 and 「进入 /」 in a loop (index read
// `false`, replaced back to splash, forever). Verified against a built rpk:
// every page bundle contains its own copy of state.js.
//
// The documented cross-page channel is the app instance: app.ux exports an
// object and pages reach it through `this.$app.$def`. app.ux exports `shared`,
// and this helper resolves it, falling back to the page-local cache when the
// runtime does not provide `$app` (tests, older firmwares). The fallback keeps
// the code runnable rather than turning a missing `$def` into a hard bounce.

export function sharedOf(vm, fallback) {
  const def = vm && vm.$app && vm.$app.$def
  const shared = def && def.shared
  if (shared) return shared
  return fallback || null
}

export default {
  sharedOf
}
