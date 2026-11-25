// Persistence for the retained conversation-list summary (`nctalk.keeper`).
//
// Two writers share this key: the `keeper` micro service (when the app is gone)
// and app.ux's own background sync (while the process is still alive, see
// common/scripts/bgSync.js). They never run at the same time - the app renews
// the service's foreground lease for as long as it is alive - but they must
// agree on the shape and on how a failure is reported, so the code lives here
// instead of once per side.

import storage from '@system.storage'
import { SUMMARY_KEY } from './keeper'

/**
 * Resolves with the raw stored string ('' when there is nothing yet).
 * A read failure is not fatal: an empty summary is a valid answer and the next
 * successful poll overwrites it anyway.
 */
export function readSummary() {
  return new Promise((resolve) => {
    try {
      storage.get({
        key: SUMMARY_KEY,
        default: '',
        success: (value) => resolve(value || ''),
        fail: (data, code) => {
          console.log('summary: read failed, code=' + code)
          resolve('')
        }
      })
    } catch (err) {
      console.log('summary: read threw: ' + ((err && err.message) || err))
      resolve('')
    }
  })
}

export function writeSummary(summary) {
  return new Promise((resolve, reject) => {
    try {
      storage.set({
        key: SUMMARY_KEY,
        value: JSON.stringify(summary),
        success: () => resolve(),
        fail: (data, code) => reject(new Error('summary write failed, code=' + code))
      })
    } catch (err) {
      reject(err)
    }
  })
}

export default {
  readSummary,
  writeSummary
}
