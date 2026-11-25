// Page navigation that only uses the form this firmware actually honours.
//
// Two device reports, in order:
//
//   1.0.0 — tapping a conversation card and tapping 设置 did nothing at all
//           (no transition, no error) while 刷新 on the same footer row worked.
//           The two dead handlers were the app's only `router.push` call sites;
//           every transition that demonstrably lands (splash → index / setup /
//           offline) uses `router.replace`.
//   1.0.1 — same dead taps, and now 刷新 is dead too. 1.0.1's only change to
//           the tap path was adding the push → wait → replace fallback and the
//           `leftPage` flag it consults. So the fallback is what failed: a
//           dropped `push` still runs the page's onHide (the runtime reacts to
//           the request, not to the result), `leftPage` then reads "we left",
//           and the retry is skipped forever — a silent no-op again, this time
//           with a guard that hides it.
//
// Hence the rule now: **there is exactly one form, and it is `replace`** — the
// one every working transition in this app already uses. No push, no state
// machine that can talk itself out of retrying.
//
// What is left is the part that made the report decidable: after the replace,
// if nothing positively says we are somewhere else, say so on screen. On a
// watch with no console, a silent dead tap and a frozen screen look identical.

import router from '@system.router'
import prompt from '@system.prompt'

const SETTLE_MS = 500

export function navigate(vm, uri, params, failMessage) {
  // A second tap inside the settle window would stack two transitions.
  if (!vm || vm.navigating) return
  vm.navigating = true
  vm.leftPage = false
  const target = params ? { uri: uri, params: params } : { uri: uri }

  let threw = null
  try {
    router.replace(target)
  } catch (err) {
    threw = err
    console.log('navigate: replace threw: ' + ((err && err.message) || err) + ' -> ' + uri)
  }

  setTimeout(() => {
    vm.navigating = false
    // A throw is already proof the transition never happened: report it without
    // waiting for the "are we still here?" check to guess.
    if (!threw && left(vm, uri)) return
    prompt.showToast({ message: failMessage || '打不开，请重试', duration: 2500 })
  }, SETTLE_MS)
}

// Did we actually leave? Three independent answers, and any one of them is
// enough. `leftPage` is set by the page's own onHide/onDestroy, `$visible` is
// the runtime's, and the router can be asked directly — that last one is the
// only answer that comes from the router rather than from the page we are
// trying to leave, so it is checked first.
function left(vm, uri) {
  if (onRoute(uri)) return true
  if (vm.destroyedPage) return true
  if (vm.leftPage) return true
  return vm.$visible === false
}

// `getState()` is not guaranteed on this firmware; a missing or odd answer just
// means "no opinion", never a false "we left".
function onRoute(uri) {
  if (!uri) return false
  let info = null
  try {
    info = typeof router.getState === 'function' ? router.getState() : null
  } catch (err) {
    return false
  }
  if (!info) return false
  const current = info.path || info.uri || ''
  return typeof current === 'string' && current.indexOf(uri) >= 0
}

/**
 * Leave a page that was installed with replace() rather than push(). It sits at
 * the bottom of the stack, where back() has nowhere to go; in that case go to
 * `home` instead of doing nothing.
 */
export function leave(home) {
  let info = null
  try {
    info = typeof router.getState === 'function' ? router.getState() : null
  } catch (err) {
    info = null
  }
  if (info && info.index > 0) {
    router.back()
    return
  }
  router.replace({ uri: home })
}

export default {
  navigate: navigate,
  leave: leave
}
