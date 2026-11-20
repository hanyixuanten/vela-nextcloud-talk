// Minimal stand-in for Vela's @system.network.
//
// tests/run.sh rewrites the `@system.network` import in network.js to this
// file, so the real gate code runs on Node. The test mutates `state` before
// each case instead of monkey-patching the module.

export const state = {
  type: 'wifi',
  fail: false,
  // Neither success nor fail: the firmware bug the gate now has to survive.
  hang: false
}

export function reset(type) {
  state.type = type === undefined ? 'wifi' : type
  state.fail = false
  state.hang = false
}

export default {
  getType(options) {
    const opts = options || {}
    if (state.fail) {
      if (opts.fail) opts.fail({ data: 'network api unavailable' }, 200)
      return
    }
    if (state.hang) return
    if (opts.success) opts.success({ type: state.type })
    if (opts.complete) opts.complete()
  }
}
