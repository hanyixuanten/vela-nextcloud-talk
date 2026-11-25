// Keep-alive audio: the HyperBilibili way of "挂后台" (commit 0ccb19b there
// declares exactly this pair, and its floating resume icon on the watch face
// is the media card the platform shows while audio is playing).
//
// Mechanism: when the app leaves the screen a packaged silent WAV starts
// looping at volume 0. The platform then treats the app as running in the
// background (system.audio is declared in config.background.features), shows
// the media entry on the watch face, and tapping it returns to the app with
// every page still alive — state intact, no cold start. onShow stops it.
//
// `@system.audio` is resolved lazily, in a try/catch, exactly like
// `@system.serviceclient` in keeperClient.js: a module-level import of a
// missing feature throws during app.ux initialisation and takes everything
// down with it.

const SILENT_WAV = '/common/audio/keepalive.wav'

let audio = null
let resolved = false
let playing = false

function audioFeature() {
  if (resolved) return audio
  resolved = true
  try {
    audio = require('@system.audio')
  } catch (err) {
    audio = null
    console.log('keep alive audio: @system.audio unavailable (' + ((err && err.message) || err) + ')')
  }
  if (!audio || typeof audio.play !== 'function') {
    audio = null
    console.log('keep alive audio: this firmware has no audio, background resume stays on the request ticker')
  }
  return audio
}

/** Start the silent loop. Called from app.ux onHide; safe to call twice. */
function start() {
  const a = audioFeature()
  if (!a || playing) return
  try {
    a.src = SILENT_WAV
    a.loop = true
    a.volume = 0
    // The watch-face media entry reads these; make it name the app instead of
    // showing a bare "playing".
    a.title = 'Talk'
    a.play()
    playing = true
    console.log('keep alive audio: started')
  } catch (err) {
    playing = false
    console.log('keep alive audio: play failed: ' + ((err && err.message) || err))
  }
}

/** Stop the loop. Called from app.ux onShow / onDestroy. */
function stop() {
  if (!playing) return
  playing = false
  try {
    const a = audioFeature()
    if (a && typeof a.stop === 'function') a.stop()
    console.log('keep alive audio: stopped')
  } catch (err) {
    console.log('keep alive audio: stop failed: ' + ((err && err.message) || err))
  }
}

export default {
  start,
  stop,
  isActive: () => playing
}
