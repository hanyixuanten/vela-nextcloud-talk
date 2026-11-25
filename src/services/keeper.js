// `keeper` micro service: keeps the Talk conversation list warm while the app
// is in the background (or closed) and remembers the last unread state.
//
// Vela runs this file outside the app lifecycle (manifest.json `services`), so
// it may only use the service-side feature set: system.device / fetch /
// interconnect / request / storage / file / vibrator / geolocation / sensor /
// audio / crypto / assetstore / zip. `system.serviceclient` is page-side only;
// the service talks back through the `serviceManager` global.
//
// Everything decision-shaped lives in common/scripts/keeper.js so it can be
// unit tested without a watch. This file is only the platform binding.

import vibrator from '@system.vibrator'
import api from '../common/scripts/api'
import store from '../common/scripts/store'
import fmt from '../common/scripts/format'
import { readSummary, writeSummary } from '../common/scripts/summary'
import { createKeeper, SERVICE_NAME } from '../common/scripts/keeper'

// serviceManager.postMessage is documented twice with different signatures:
// postMessage(clientId, Object) in the table (clientId optional, 0 = broadcast)
// and postMessage({ clientId, params }) in the only example. The table form is
// tried per client first — it is the one whose meaning is unambiguous — then
// the example form, then a plain broadcast.
function notifyClients(payload) {
  if (typeof serviceManager === 'undefined' || !serviceManager) return

  let clients = []
  try {
    if (typeof serviceManager.getClientsInfo === 'function') {
      clients = serviceManager.getClientsInfo() || []
    }
  } catch (err) {
    console.log('keeper: getClientsInfo failed: ' + ((err && err.message) || err))
  }

  if (clients.length && typeof serviceManager.postMessage === 'function') {
    clients.forEach((client) => {
      const id = client && client.id
      if (id === undefined || id === null) return
      try {
        serviceManager.postMessage(id, payload)
      } catch (err) {
        console.log('keeper: postMessage(clientId, payload) failed: ' + ((err && err.message) || err))
      }
    })
    return
  }

  try {
    serviceManager.postMessage({ clientId: 0, params: payload })
    return
  } catch (err) {
    console.log('keeper: postMessage(object) failed: ' + ((err && err.message) || err))
  }
  try {
    serviceManager.postMessage(0, payload)
  } catch (err) {
    console.log('keeper: postMessage(0, payload) failed: ' + ((err && err.message) || err))
  }
}

const keeper = createKeeper({
  // api.js keeps its own credential copy; configure it from the same read the
  // decision logic uses, so a changed account or app password is picked up
  // without restarting the service (and without a second storage read).
  loadSettings: () => {
    return store.load().then((settings) => {
      api.configure(settings)
      return settings
    })
  },
  listRooms: () => api.listConversations(),
  loadSummary: readSummary,
  saveSummary: writeSummary,
  formatPreview: (message) => fmt.previewWithAuthor(message),
  vibrate: (mode) => {
    try {
      vibrator.vibrate({ mode: mode || 'short' })
    } catch (err) {
      console.log('keeper: vibrate failed: ' + ((err && err.message) || err))
    }
  },
  notify: notifyClients,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id),
  now: () => Date.now()
})

export default {
  onCreate(params) {
    console.log('keeper: service onCreate, name=' + SERVICE_NAME)
    keeper.start()
  },

  onConnect(clientId, params) {
    keeper.onConnect(clientId)
  },

  onDisConnect(clientId) {
    keeper.onDisConnect(clientId)
  },

  onMessage(clientId, params) {
    return keeper.onMessage(clientId, params)
  },

  onDestroy() {
    keeper.stop()
    console.log('keeper: service onDestroy')
  }
}
