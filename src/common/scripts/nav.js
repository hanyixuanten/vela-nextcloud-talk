// Page navigation on a firmware that can drop a transition without a word.
//
// Device history, in order — each report narrowed the next guess:
//
//   1.0.0 — tapping a conversation card and tapping 设置 did nothing at all
//           (no transition, no error) while 刷新 on the same footer row worked.
//           The two dead handlers were the app's only `router.push` call sites;
//           every transition that demonstrably lands (splash → index / setup /
//           offline) uses `router.replace`. So: push is dropped.
//   1.0.1 — same dead taps, and 刷新 died too. 1.0.1 had added push → 300ms →
//           replace, and the fallback was the new failure: a dropped push still
//           runs the page's onHide (the runtime reacts to the request, not to
//           the result), so `leftPage` said "we left" and the retry was skipped
//           for good — silent again, this time hidden by a flag.
//   1.0.2 — replace only, and the watch now shows 「打不开，请重试」. That is
//           progress, and it says two things: the tap reaches the handler, and
//           the transition issued from inside the touch callback does not land.
//           pages/splash has known this all along — it documents that a
//           `router.replace` issued in the same tick can be dropped, defers by
//           30ms and retries at 1200ms. That is the only place in the app where
//           a transition is *proven* to work.
//   1.0.3 — deferred replace, params-less replace and a deferred push, spread
//           over 2.4s: still nothing, and the toast arrived at ~4s, i.e. after
//           every rung. Form and timing are ruled out; the page that failed to
//           construct was the answer all along — see the note in pages/chat
//           about `data` next to `protected`.
//
// Hence this ladder. Every attempt is deferred out of the touch callback, each
// one varies exactly one thing, and the page is given time to appear before the
// next rung:
//
//   +30ms    replace(uri, params)     the working form, deferred (splash's fix)
//   +1300ms  replace(uri)             same form, no params — rules params out
//   +2400ms  push(uri, params)        the other form, now deferred — rules form out
//   +3600ms  still here → toast       plus the router's own before/after state on
//                                     the page that asked, so the next report is
//                                     a fact rather than a symptom.
//
// "Did we get there?" no longer relies on the page's own lifecycle: a landed
// transition on this firmware does not always run onHide/onDestroy, and 1.0.2's
// single check could therefore cry wolf over a page that had in fact opened.
// The router is snapshotted before the first attempt and compared after each
// one, which is the only evidence that comes from the router rather than from
// the page we are leaving.

import router from '@system.router'
import prompt from '@system.prompt'

// Absolute ms after the tap. Spread wide enough that a slow first paint (the
// chat page builds a message list and a keyboard) is not mistaken for a drop.
const LADDER = [
  { at: 30, form: 'replace', withParams: true },
  { at: 1300, form: 'replace', withParams: false },
  { at: 2400, form: 'push', withParams: true }
]
const GIVE_UP_AT = 3600

// How long a leave() rung gets before the router is asked whether it landed.
// Long enough for a chat -> list transition to paint on the watch, short enough
// that a dropped back() does not feel like a dead button.
const LEAVE_VERIFY_MS = 700

export function navigate(vm, uri, params, failMessage, onFail) {
  // A second tap inside the ladder would stack two transitions.
  if (!vm || vm.navigating) return
  vm.navigating = true
  vm.leftPage = false

  const before = snapshot()
  const timers = []
  const thrown = []
  let settled = false

  const settle = (arrived) => {
    if (settled) return
    settled = true
    timers.forEach((id) => clearTimeout(id))
    vm.navigating = false
    if (arrived) return
    // Honest, and the only channel a wrist has: this toast is what told us the
    // 1.0.2 transition was issued and dropped.
    prompt.showToast({ message: failMessage || '打不开，请重试', duration: 2500 })
    // And the detail goes to whoever can render it: "打不开" alone narrowed the
    // guess, it did not settle it.
    if (typeof onFail === 'function') {
      try {
        onFail({ uri: uri, thrown: thrown, before: before, after: snapshot() })
      } catch (err) {
        console.log('navigate: onFail handler threw: ' + ((err && err.message) || err))
      }
    }
  }

  LADDER.forEach((step) => {
    timers.push(setTimeout(() => {
      if (settled) return
      if (moved(vm, uri, before)) {
        settle(true)
        return
      }
      const target = step.withParams && params ? { uri: uri, params: params } : { uri: uri }
      try {
        if (step.form === 'push') router.push(target)
        else router.replace(target)
      } catch (err) {
        // A throwing form is proof that rung never happened; the next one still
        // gets its turn, and the toast stays the last word. Keep the message:
        // on a watch it is the only thing that can be shown to the user.
        const message = (err && err.message) || String(err)
        thrown.push('+' + step.at + 'ms ' + step.form + ': ' + message)
        console.log('navigate: ' + step.form + ' threw at +' + step.at + 'ms: ' + message + ' -> ' + uri)
      }
    }, step.at))
  })

  timers.push(setTimeout(() => {
    if (moved(vm, uri, before)) settle(true)
    else settle(false)
  }, GIVE_UP_AT))
}

// Did we actually leave? Positive evidence only: the page saying so, the
// runtime's own visibility flag, or the router reporting a different route.
function moved(vm, uri, before) {
  if (vm.destroyedPage || vm.leftPage) return true
  if (vm.$visible === false) return true
  const now = snapshot()
  if (!now) return false
  const current = String(now.path || now.name || '')
  if (uri && current.indexOf(uri) >= 0) return true
  if (!before) return false
  return now.index !== before.index || now.path !== before.path || now.name !== before.name
}

// `getState()` is not guaranteed on this firmware; a missing or odd answer is
// "no opinion", never a false "we left".
function snapshot() {
  try {
    const info = typeof router.getState === 'function' ? router.getState() : null
    if (!info) return null
    return {
      index: info.index,
      path: info.path || info.uri || '',
      name: info.name || ''
    }
  } catch (err) {
    return null
  }
}

/**
 * Leave a page that may have been installed with replace() rather than push().
 * It then sits at the bottom of the stack, where back() has nowhere to go; in
 * that case go to `home` instead of doing nothing.
 *
 * Both rungs need the same treatment as navigate(): the transition is deferred
 * out of the tap callback, and none of the two forms is trusted to land. 1.0.7
 * shipped the naive version — `getState().index > 0 → router.back()` — and the
 * chat page's 返回 button became a silent no-op: the router still reported a
 * stack depth for a page that had been installed by a replace, back() was
 * dropped, and nothing fell through to the replace that would have worked. So
 * back() is now verified against a snapshot and the replace is the fallback,
 * exactly like the forward ladder.
 *
 * `onFail` runs when even the fallback did not move us: the page is still on
 * screen, and it is the page's job to restore whatever it paused on the way out.
 */
export function leave(home, onFail) {
  const before = snapshot()
  const depth = before && typeof before.index === 'number' ? before.index : 0
  let settled = false

  const settle = (arrived) => {
    if (settled) return
    settled = true
    if (arrived) return
    console.log('leave: still on the page after back() and replace() -> ' + home)
    if (typeof onFail === 'function') {
      try {
        onFail()
      } catch (err) {
        console.log('leave: onFail handler threw: ' + ((err && err.message) || err))
      }
    }
  }

  const replaceHome = () => {
    setTimeout(() => {
      try {
        router.replace({ uri: home })
      } catch (err) {
        console.log('leave: replace threw: ' + ((err && err.message) || err) + ' -> ' + home)
      }
    }, 30)
  }

  if (depth > 0 && typeof router.back === 'function') {
    try {
      router.back()
    } catch (err) {
      // A throwing back() is proof it never happened; the replace gets its turn.
      console.log('leave: back threw: ' + ((err && err.message) || err))
      replaceHome()
    }
    // A dropped back() looks exactly like a landed one from inside the page, so
    // the router has to answer before the fallback is spent or skipped.
    setTimeout(() => {
      if (arrivedHome(home, before)) {
        settle(true)
        return
      }
      replaceHome()
      setTimeout(() => settle(arrivedHome(home, before)), LEAVE_VERIFY_MS)
    }, LEAVE_VERIFY_MS)
    return
  }

  replaceHome()
  setTimeout(() => settle(arrivedHome(home, before)), LEAVE_VERIFY_MS)
}

// Left the page? Either the router is on `home` now, or it is on a different
// route than the one we took the snapshot on. No getState() means no evidence,
// which is why the caller never treats a missing snapshot as an arrival.
function arrivedHome(home, before) {
  const now = snapshot()
  if (!now) return false
  const current = String(now.path || now.name || '')
  if (home && current.indexOf(home) >= 0) return true
  if (!before) return true
  return now.index !== before.index || now.path !== before.path || now.name !== before.name
}

export default {
  navigate: navigate,
  leave: leave
}
