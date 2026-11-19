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
    if (options.url.indexOf('/hang') >= 0) return
    const init = { method: options.method || 'GET', headers: options.header || {} }
    if (options.data !== undefined) init.body = options.data

    // The production API enforces HTTPS before attaching Basic credentials.
    // Tests use a local plain-HTTP server, so this adapter maps only loopback
    // HTTPS URLs to that test server while preserving the production URL contract.
    const url = new URL(options.url)
    if (url.hostname === '127.0.0.1' && url.protocol === 'https:') url.protocol = 'http:'

    globalThis
      .fetch(url, init)
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
