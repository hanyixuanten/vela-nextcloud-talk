// Minimal stand-in for Vela's @system.fetch.
//
// api.js imports '@system.fetch', which Node cannot resolve (the name has a dot
// and no scope). tests/run.sh rewrites that import to this file so the real
// api.js source can be executed unmodified outside the watch runtime.
//
// The contract mirrored here is the callback one documented at
// https://iot.mi.com/vela/quickapp/zh/features/network/fetch.html :
//   success({ code, data, headers })  /  fail(data, code)

export default {
  fetch(options) {
    const init = { method: options.method || 'GET', headers: options.header || {} }
    if (options.data !== undefined) init.body = options.data

    globalThis
      .fetch(options.url, init)
      .then(async (response) => {
        const text = await response.text()
        const headers = {}
        response.headers.forEach((value, key) => {
          headers[key] = value
        })
        if (options.success) options.success({ code: response.status, data: text, headers })
      })
      .catch((err) => {
        if (options.fail) options.fail({ data: String((err && err.message) || err) }, 1000)
      })
  }
}
