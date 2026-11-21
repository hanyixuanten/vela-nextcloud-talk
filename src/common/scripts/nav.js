// Page navigation that does not trust router.push().
//
// Report from the watch (0.2.13): tapping a conversation card, and tapping 设置
// in the footer, both did nothing at all — no transition, no error. 刷新 on the
// same footer row worked, and it is the only one of the three that does not
// navigate. Both dead taps are the two call sites of `router.push` in the app;
// every other transition (splash → index / setup / offline) uses
// `router.replace` and demonstrably lands. So on this firmware `push` can
// silently do nothing, and a silent no-op on a watch is indistinguishable from
// a frozen screen: there is no console to read.
//
// Hence this helper treats push as "may not land":
//
//   1. remember that we are leaving (the page sets `leftPage` in onHide);
//   2. push();
//   3. shortly after, if the page is still here, replace() to the same target —
//      the form the launch gate uses;
//   4. if that also leaves us here, say so on screen instead of swallowing it.
//
// The point of (4) is the next bug report: a toast means "navigation ran and
// both forms were dropped", no toast means "the tap never reached the handler".

import router from '@system.router'
import prompt from '@system.prompt'

const PUSH_CHECK_MS = 300
const REPLACE_CHECK_MS = 400

export function navigate(vm, uri, params, failMessage) {
  if (!vm || vm.navigating) return
  vm.navigating = true
  const target = params ? { uri: uri, params: params } : { uri: uri }

  try {
    router.push(target)
  } catch (err) {
    console.log('navigate: push threw: ' + ((err && err.message) || err) + ' -> ' + uri)
  }

  setTimeout(() => {
    vm.navigating = false
    // onHide / onDestroy ran (or the runtime says we are not visible), so the
    // push did land. Nothing else to do.
    if (left(vm)) return

    console.log('navigate: still on the page after push, replacing: ' + uri)
    try {
      router.replace(target)
    } catch (err) {
      console.log('navigate: replace threw: ' + ((err && err.message) || err) + ' -> ' + uri)
    }

    setTimeout(() => {
      if (left(vm)) return
      prompt.showToast({ message: failMessage || '打不开，请重试', duration: 2500 })
    }, REPLACE_CHECK_MS)
  }, PUSH_CHECK_MS)
}

// Did we actually leave? `leftPage` is set by the page's own onHide/onDestroy;
// `$visible === false` is the runtime's own answer where it exists. Both must
// say "still here" before we treat the navigation as dropped.
function left(vm) {
  if (vm.leftPage) return true
  return vm.$visible === false
}

/**
 * Leave a page that may have been installed by navigate()'s replace fallback.
 * A replaced page sits at the bottom of the stack, where back() has nowhere to
 * go; in that case go to `home` instead of doing nothing.
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
