// Stand-in for '@system.storage' on desktop Node.
//
// The real module is callback based and its failure payload is not uniform
// across Vela builds, so the double lets each test choose exactly how the
// platform answers: success, fail(data, code), fail({data, code}), fail() with
// no arguments, or a synchronous throw.

export const log = []

export const behaviour = {
  set: null,
  get: null,
  clear: null
}

export function reset() {
  log.length = 0
  behaviour.set = null
  behaviour.get = null
  behaviour.clear = null
}

function dispatch(op, options, args) {
  const handler = behaviour[op]
  if (handler) return handler(options, args)
  options.success('')
}

export default {
  set(options) {
    log.push({ op: 'set', key: options.key, chars: String(options.value || '').length })
    return dispatch('set', options)
  },

  get(options) {
    log.push({ op: 'get', key: options.key })
    return dispatch('get', options)
  },

  clear(options) {
    log.push({ op: 'clear' })
    return dispatch('clear', options)
  }
}
