// Background retention logic (common/scripts/keeper.js).
//
// The service body is driven entirely through injected dependencies, so these
// tests pin the decisions that used to be untestable: who polls (pages while
// foreground, service while not), when a buzz happens, and what survives a
// failed poll or a corrupt summary.
//
// Run with: sh tests/run.sh

import assert from 'node:assert/strict'
import keeper, {
  createKeeper,
  summarizeRooms,
  shouldPoll,
  intervalFor,
  parseSummary,
  accountKey,
  emptySummary,
  isForeground,
  leaseRemaining,
  MIN_BACKGROUND_INTERVAL_MS,
  BUZZ_COOLDOWN_MS,
  FOREGROUND_LEASE_MS
} from './.build/keeper.mjs'

let passed = 0
let failed = 0
const queue = []

function test(name, fn) {
  queue.push({ name, fn })
}

async function flush() {
  // Let promise chains inside the keeper settle.
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function makeDeps(options) {
  const opts = options || {}
  const clock = { now: 1000000 }
  const timers = []
  let seq = 0
  const record = {
    saved: [],
    notified: [],
    buzzes: [],
    polls: 0,
    logs: []
  }
  const settings = opts.settings || {
    baseUrl: 'https://cloud.example.com',
    user: 'alice',
    appPassword: 'app-password',
    pollInterval: 15000
  }
  const deps = {
    loadSettings: () => Promise.resolve(settings),
    listRooms: () => {
      record.polls += 1
      if (record.failNext) {
        record.failNext = false
        return Promise.reject(new Error('offline'))
      }
      return Promise.resolve(record.rooms || [])
    },
    loadSummary: () => Promise.resolve(record.rawSummary === undefined ? '' : record.rawSummary),
    saveSummary: (summary) => {
      record.saved.push(summary)
      return Promise.resolve()
    },
    formatPreview: (message) => (message && message.message ? 'p:' + message.message : ''),
    vibrate: (mode) => record.buzzes.push(mode),
    notify: (payload) => record.notified.push(payload),
    setTimer: (fn, ms) => {
      seq += 1
      timers.push({ id: seq, fn: fn, ms: ms })
      return seq
    },
    clearTimer: (id) => {
      const index = timers.findIndex((item) => item.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    now: () => clock.now,
    log: (message) => record.logs.push(message)
  }
  return { deps: deps, record: record, clock: clock, timers: timers, settings: settings }
}

// Fire exactly one scheduled poll and let the chain inside it settle.
// Firing them in a loop would follow the service forever: every poll schedules
// the next one.
async function runNext(timers) {
  const next = timers.shift()
  if (!next) return
  next.fn()
  await flush()
}

const ROOMS = [
  {
    token: 'room-a',
    displayName: '项目群',
    unreadMessages: 2,
    lastActivity: 1700000000,
    lastMessage: { message: 'hello' }
  },
  {
    token: 'room-b',
    displayName: 'Alice',
    unreadMessages: 0,
    lastActivity: 1700000100,
    lastMessage: null
  }
]

async function run() {
  for (const item of queue) {
    try {
      await item.fn()
      passed += 1
      console.log('  ok   ' + item.name)
    } catch (err) {
      failed += 1
      console.log('  FAIL ' + item.name)
      console.log('       ' + ((err && err.message) || err))
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  if (failed > 0) process.exitCode = 1
}

console.log('keeper.js pure helpers')

test('shouldPoll: only the background service polls', () => {
  assert.equal(shouldPoll({ enabled: true, ready: true, inflight: false, foreground: false }), true)
  // Foreground pages already fetch the same list; a second poller is waste.
  assert.equal(shouldPoll({ enabled: true, ready: true, inflight: false, foreground: true }), false)
  assert.equal(shouldPoll({ enabled: false, ready: true, inflight: false, foreground: false }), false)
  assert.equal(shouldPoll({ enabled: true, ready: false, inflight: false, foreground: false }), false)
  assert.equal(shouldPoll({ enabled: true, ready: true, inflight: true, foreground: false }), false)
  assert.equal(shouldPoll(null), false)
})

test('the foreground lease is what pauses the service, not a boolean', () => {
  // A plain flag was the 1.0.14 bug: a process killed without onHide left it
  // true for good, so the service polled nothing until reboot.
  assert.equal(isForeground(0, 1000), false, 'no lease is "not foreground"')
  assert.equal(isForeground(2000, 1000), true)
  assert.equal(isForeground(2000, 2000), false, 'the lease expires exactly at its end')
  assert.equal(isForeground(undefined, 1000), false)
  assert.equal(leaseRemaining(2000, 1000), 1000)
  assert.equal(leaseRemaining(2000, 2500), 0)
  assert.equal(leaseRemaining(0, 2500), 0)
  assert.ok(FOREGROUND_LEASE_MS >= MIN_BACKGROUND_INTERVAL_MS, 'a lease spans at least one background period')
})

test('intervalFor clamps the background period to the floor', () => {
  assert.equal(intervalFor(15000), MIN_BACKGROUND_INTERVAL_MS)
  assert.equal(intervalFor(30000), MIN_BACKGROUND_INTERVAL_MS)
  assert.equal(intervalFor(60000), 60000)
  assert.equal(intervalFor(undefined), MIN_BACKGROUND_INTERVAL_MS)
})

test('intervalMs overrides the stored poll interval (in-app background ticker)', async () => {
  // app.ux's background sync must tick inside the platform's 20s window, so it
  // cannot inherit either the 60s setting or the service's 30s floor.
  const env = makeDeps()
  env.deps.intervalMs = 15000
  env.settings.pollInterval = 60000
  const service = createKeeper(env.deps)
  await service.start()
  await runNext(env.timers)
  assert.equal(env.record.polls, 1)
  assert.equal(env.timers[0].ms, 15000, 'the explicit cadence wins over pollInterval')
  assert.equal(service.state().interval, 15000)
})

test('summarizeRooms keeps name/preview/unread and totals unread', () => {
  const summary = summarizeRooms(ROOMS, (message) => (message ? message.message : ''), 42)
  assert.equal(summary.total, 2)
  assert.equal(summary.at, 42)
  assert.equal(summary.rooms.length, 2)
  assert.deepEqual(summary.rooms[0], {
    token: 'room-a',
    name: '项目群',
    preview: 'hello',
    unread: 2,
    at: 1700000000
  })
  assert.equal(summary.rooms[1].preview, '')
})

test('summarizeRooms drops entries without a token and survives junk', () => {
  const summary = summarizeRooms([null, {}, { token: 'x' }, undefined], null, 1)
  assert.equal(summary.rooms.length, 1)
  assert.equal(summary.rooms[0].name, 'x')
  assert.equal(summary.total, 0)
})

test('parseSummary rejects corrupt JSON and unknown shapes', () => {
  assert.deepEqual(parseSummary(''), emptySummary())
  assert.deepEqual(parseSummary('{not json'), emptySummary())
  assert.deepEqual(parseSummary('null'), emptySummary())
  assert.deepEqual(parseSummary('[]'), emptySummary())
})

test('parseSummary recomputes the total instead of trusting the stored one', () => {
  const summary = parseSummary(
    JSON.stringify({
      at: 7,
      total: 999,
      account: 'alice@https://cloud.example.com',
      rooms: [{ token: 'a', name: 'A', unread: 3 }, { token: 'b', name: 'B', unread: 0 }]
    })
  )
  assert.equal(summary.total, 3)
  assert.equal(summary.at, 7)
  assert.equal(summary.account, 'alice@https://cloud.example.com')
  assert.equal(summary.rooms.length, 2)
})

test('accountKey identifies the credentials a summary belongs to', () => {
  assert.equal(
    accountKey({ baseUrl: 'https://cloud.example.com', user: 'alice' }),
    'alice@https://cloud.example.com'
  )
  assert.equal(accountKey({ user: 'alice' }), '')
  assert.equal(accountKey(null), '')
})

console.log('\nkeeper.js service body')

test('first poll stays quiet: existing unread must not buzz', async () => {
  const env = makeDeps()
  env.record.rooms = ROOMS
  const service = createKeeper(env.deps)
  await service.start()
  assert.equal(env.timers.length, 1, 'start schedules an immediate poll')
  await runNext(env.timers)

  assert.equal(env.record.polls, 1)
  assert.equal(env.record.buzzes.length, 0)
  assert.equal(env.record.saved.length, 1)
  assert.equal(env.record.saved[0].total, 2)
  assert.equal(env.record.saved[0].account, 'alice@https://cloud.example.com')
  assert.equal(env.timers.length, 1, 'next poll is scheduled')
  assert.equal(env.timers[0].ms, MIN_BACKGROUND_INTERVAL_MS)
})

test('a rising unread count buzzes once, then respects the cooldown', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)

  env.record.rooms = [Object.assign({}, ROOMS[0], { unreadMessages: 1 })]
  await service.start()
  await runNext(env.timers)
  assert.equal(env.record.buzzes.length, 0, 'baseline poll is silent')

  env.record.rooms = [Object.assign({}, ROOMS[0], { unreadMessages: 3 })]
  await runNext(env.timers)
  assert.deepEqual(env.record.buzzes, ['short'])

  // Another message inside the cooldown: the summary updates, the wrist stays quiet.
  env.record.rooms = [Object.assign({}, ROOMS[0], { unreadMessages: 5 })]
  await runNext(env.timers)
  assert.equal(env.record.buzzes.length, 1)
  assert.equal(service.summary().total, 5)

  env.clock.now += BUZZ_COOLDOWN_MS + 1
  env.record.rooms = [Object.assign({}, ROOMS[0], { unreadMessages: 6 })]
  await runNext(env.timers)
  assert.equal(env.record.buzzes.length, 2)
})

test('unread going down never buzzes', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)
  env.record.rooms = [Object.assign({}, ROOMS[0], { unreadMessages: 4 })]
  await service.start()
  await runNext(env.timers)

  env.record.rooms = [Object.assign({}, ROOMS[0], { unreadMessages: 0 })]
  await runNext(env.timers)
  assert.equal(env.record.buzzes.length, 0)
  assert.equal(service.summary().total, 0)
})

test('foreground pauses polling, background resumes it', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)
  await service.start()
  await runNext(env.timers)
  const pollsAfterStart = env.record.polls
  assert.equal(pollsAfterStart, 1)

  await service.onMessage(0, { type: 'foreground' })
  assert.equal(service.state().foreground, true)
  assert.equal(env.timers.length, 1, 'the lease schedules a wake-up instead of polling')
  assert.equal(env.timers[0].ms, FOREGROUND_LEASE_MS + 1000, 'wake up when the lease runs out')
  await service.tick()
  assert.equal(env.record.polls, pollsAfterStart, 'no request while foreground')
  assert.equal(env.timers.length, 1, 'the pending wake-up is not duplicated')

  await service.onMessage(0, { type: 'background' })
  await flush()
  assert.equal(env.record.polls, pollsAfterStart + 1)
  assert.equal(env.timers.length, 1, 'background reschedules')
})

test('a foreground lease that is never renewed expires and polling resumes', async () => {
  // The failure mode this replaces: the app said "I am visible" and then died.
  const env = makeDeps()
  const service = createKeeper(env.deps)
  env.record.rooms = ROOMS
  await service.start()
  await runNext(env.timers)
  const before = env.record.polls

  await service.onMessage(0, { type: 'foreground' })
  await service.tick()
  assert.equal(env.record.polls, before, 'still paused')

  // No further message from the app: only the clock moves.
  env.clock.now += FOREGROUND_LEASE_MS + 1001
  await runNext(env.timers)
  assert.equal(env.record.polls, before + 1, 'the service polls again once the lease lapses')
  assert.equal(service.state().foreground, false)
})

test('the last client disconnecting resumes polling without waiting for the lease', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)
  await service.start()
  await runNext(env.timers)
  const before = env.record.polls

  service.onConnect(1)
  await service.onMessage(0, { type: 'foreground' })
  await service.onDisConnect(1)
  await flush()
  assert.equal(env.record.polls, before + 1, 'a closed app is not "on screen"')
})

test('retention cannot be switched off: a stale backgroundKeep=false is ignored', async () => {
  // 1.0.14 stored the switch in settings; the flag is gone from store.js, and a
  // leftover value in storage must not bring it back.
  const env = makeDeps({ settings: Object.assign({}, makeDeps().settings, { backgroundKeep: false }) })
  const service = createKeeper(env.deps)
  await service.start()
  await runNext(env.timers)
  assert.equal(env.record.polls, 1, 'the service keeps polling')
  assert.equal(env.record.saved.length, 1)
  assert.equal(env.timers.length, 1, 'and keeps rescheduling')
  assert.equal(service.state().enabled, true)
})

test('no account performs no request', async () => {
  const env = makeDeps({ settings: { baseUrl: '', user: '', appPassword: '' } })
  const service = createKeeper(env.deps)
  await service.start()
  await runNext(env.timers)
  assert.equal(env.record.polls, 0)
})

test('a failed poll keeps the last good summary and retries', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)
  env.record.rooms = ROOMS
  await service.start()
  await runNext(env.timers)
  const good = service.summary()
  assert.equal(good.total, 2)

  env.record.failNext = true
  await runNext(env.timers)
  assert.equal(service.summary().total, 2, 'previous summary survives')
  assert.equal(env.record.saved.length, 1, 'nothing persisted on failure')
  assert.equal(env.timers.length, 1, 'retry scheduled')
  assert.ok(env.record.logs.some((line) => line.indexOf('poll failed') >= 0))
})

test('connected clients receive every successful poll', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)
  env.record.rooms = ROOMS
  await service.start()
  await runNext(env.timers)
  assert.equal(env.record.notified.length, 0, 'no client, no push')

  service.onConnect(1)
  assert.equal(env.record.notified.length, 1, 'connect pushes the retained list')
  assert.equal(env.record.notified[0].type, 'rooms')
  assert.equal(env.record.notified[0].summary.total, 2)

  await runNext(env.timers)
  assert.equal(env.record.notified.length, 2)
})

test('start restores the persisted summary before the first poll', async () => {
  const env = makeDeps()
  env.record.rawSummary = JSON.stringify({
    at: 1,
    account: 'alice@https://cloud.example.com',
    rooms: [{ token: 'a', name: 'A', unread: 7, at: 2, preview: 'old' }]
  })
  const service = createKeeper(env.deps)
  await service.start()
  assert.equal(service.summary().total, 7)
  assert.equal(service.summary().rooms[0].preview, 'old')
  // The restored state is a baseline: no buzz for messages that were already
  // unread when the service came up.
  env.record.rooms = ROOMS
  await runNext(env.timers)
  assert.equal(env.record.buzzes.length, 0)
})

test('shutdown stops the timer and leaves nothing to reschedule', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)
  await service.start()
  await runNext(env.timers)
  await service.onMessage(0, { type: 'shutdown' })
  assert.equal(env.timers.length, 0)
  await runNext(env.timers)
  assert.equal(env.record.polls, 1, 'no poll after shutdown')
  assert.equal(service.state().enabled, false)
})

test('a poll that answers after shutdown does not resurrect the timer', async () => {
  const env = makeDeps()
  const service = createKeeper(env.deps)
  await service.start()
  const pending = service.tick()
  await service.onMessage(0, { type: 'shutdown' })
  await pending
  await flush()
  assert.equal(env.timers.length, 0, 'the answer belongs to a dead generation')
})

test('exports stay in sync with the manifest service name', () => {
  assert.equal(keeper.SERVICE_NAME, 'keeper')
  assert.equal(keeper.SUMMARY_KEY, 'nctalk.keeper')
})

run()
