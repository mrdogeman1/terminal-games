import { expect, test } from 'claude-code/testing'

import { createClient } from '../hooks/net/client'
import { createEventLoop } from '../hooks/net/events'
import type { GameEventEnvelope } from '../hooks/net/protocol'
import { CLIENT_ID, memoryHost, SERVER } from './kit'
import type { Reply, Sent } from './kit'

const ev = (seq: number): GameEventEnvelope =>
  ({ seq, type: 'presence.changed', at: '', gameId: null, payload: { userId: 'u', username: 'u', online: true, lastSeenAt: '' } }) as GameEventEnvelope

const page = (seqs: number[], seq: number, more = false): Reply => ({
  body: { events: seqs.map(ev), seq, more, serverTime: 1 },
})

// A server whose /events answers come from a queue; with the queue empty a
// request is held (never answered), as a long-poll with nothing new.
const setup = (store: Record<string, unknown> = {}) => {
  const replies: (Reply | Promise<Reply>)[] = []
  const host = memoryHost({ 'GET /api/mod/events': () => replies.shift() ?? new Promise<Reply>(() => {}) }, { store })
  const client = createClient(host, { serverUrl: SERVER, clientId: CLIENT_ID, token: () => 't' })
  const got: number[] = []
  const resyncs: number[] = []
  const stops: string[] = []
  const loop = createEventLoop(host, client, {
    onEvents: events => void got.push(...events.map(e => e.seq)),
    onResync: seq => void resyncs.push(seq),
    onStop: reason => void stops.push(reason),
  })
  const sinces = () =>
    host.sent.filter((s: Sent) => s.path === '/api/mod/events').map(s => new URL(s.url).searchParams.get('since'))

  return { host, replies, loop, got, resyncs, stops, sinces }
}

test('since starts at me.eventSeq, follows the server seq, is stored, and more:true asks again at once', async () => {
  const t = setup()
  t.replies.push(page([101, 102], 102, true), page([103], 110), page([], 120))
  await t.loop.start(100)
  await t.host.settle()

  expect(t.sinces()).toEqual(['100', '102'])
  expect(t.got).toEqual([101, 102, 103])
  expect(t.host.kept['events.seq']).toBe(110)

  // The next tick (500 ms) starts the next request from 110.
  await t.host.advance(500)
  expect(t.sinces()).toEqual(['100', '102', '110'])
  expect(t.host.kept['events.seq']).toBe(120)
  expect(t.host.last()?.headers['X-Client-Id']).toBe(CLIENT_ID)
})

test('a restart resumes from the stored seq, and old events are not delivered twice', async () => {
  const t = setup({ 'events.seq': 300 })
  t.replies.push(page([299, 300, 301], 301))
  await t.loop.start(5)
  await t.host.settle()
  expect(t.sinces()).toEqual(['300'])
  expect(t.got).toEqual([301])
})

test('410 events_expired resyncs and continues from the server head', async () => {
  const t = setup({ 'events.seq': 120 })
  t.replies.push({ status: 410, body: { error: 'events_expired', message: 'resync', seq: 48233 } }, page([], 48240))
  await t.loop.start()
  await t.host.settle()
  expect(t.resyncs).toEqual([48233])
  expect(t.host.kept['events.seq']).toBe(48233)

  await t.host.advance(500)
  expect(t.sinces()).toEqual(['120', '48233'])
})

test('one request in flight; a stuck one is replaced and its late answer dropped (newest wins)', async () => {
  const t = setup()
  let release: (r: Reply) => void = () => {}
  t.replies.push(new Promise<Reply>(r => (release = r)))
  await t.loop.start(10)
  await t.host.settle()

  // Ticks while the request is held start nothing.
  await t.host.advance(20_000)
  expect(t.sinces()).toEqual(['10'])

  // Past timeoutMs + grace (35 s) the loop gives up on it and asks again.
  t.replies.push(page([11], 11))
  await t.host.advance(16_000)
  expect(t.sinces()).toEqual(['10', '10', '11'])
  expect(t.got).toEqual([11])

  // The old request answers late: ignored.
  release(page([11, 12], 12))
  await t.host.settle()
  expect(t.got).toEqual([11])
  expect(t.host.kept['events.seq']).toBe(11)
})

test('network errors back off 2 s, 4 s ...; 429 waits retryAfterMs', async () => {
  const t = setup()
  t.replies.push(
    'network-error',
    'network-error',
    { status: 429, body: { error: 'rate_limited', message: 'x', retryAfterMs: 7000 } },
    page([2], 2),
  )
  await t.loop.start(1)
  await t.host.settle()
  expect(t.sinces().length).toBe(1)
  expect(t.loop.status().failures).toBe(1)

  await t.host.advance(1_500)
  expect(t.sinces().length).toBe(1)
  await t.host.advance(1_000) // 2.5 s: past the 2 s backoff
  expect(t.sinces().length).toBe(2)
  await t.host.advance(3_000) // second failure waits 4 s
  expect(t.sinces().length).toBe(2)
  await t.host.advance(1_500)
  expect(t.sinces().length).toBe(3) // the 429
  await t.host.advance(5_500) // 429 at 6 s: nothing before 13 s
  expect(t.sinces().length).toBe(3)
  await t.host.advance(1_000)
  expect(t.sinces().length).toBe(5) // the success, then the next (held) request
  expect(t.loop.status().failures).toBe(0)
})

test('401 stops the loop', async () => {
  const t = setup()
  t.replies.push({ status: 401, body: { error: 'unauthorized', message: 'gone' } })
  await t.loop.start(1)
  await t.host.settle()
  expect(t.stops).toEqual(['unauthorized'])
  await t.host.advance(5_000)
  expect(t.sinces().length).toBe(1)
  expect(t.loop.status().isRunning).toBe(false)
})

test('a slow handler keeps the request in flight; a failing handler or resync backs off without storing seq', async () => {
  const replies: Reply[] = [page([11], 11), page([12], 12), { status: 410, body: { error: 'events_expired', message: 'resync', seq: 900 } }]
  const host = memoryHost({ 'GET /api/mod/events': () => replies.shift() ?? new Promise<Reply>(() => {}) })
  const client = createClient(host, { serverUrl: SERVER, clientId: CLIENT_ID, token: () => 't' })
  let finish: () => void = () => {}
  let calls = 0
  const loop = createEventLoop(host, client, {
    onEvents: () => {
      calls++
      if (calls === 1) return new Promise<void>(r => (finish = r))
      throw new Error('handler broke')
    },
    onResync: () => {
      throw new Error('resync broke')
    },
  })
  const polls = () => host.sent.filter((s: Sent) => s.path === '/api/mod/events').length

  await loop.start(10)
  await host.settle()
  await host.advance(1_000)
  expect(polls()).toBe(1)
  expect(loop.status().isInFlight).toBe(true)

  finish()
  await host.settle()
  expect(host.kept['events.seq']).toBe(11)
  expect(loop.status().isInFlight).toBe(false)

  // The handler throws: seq stays, the loop backs off 2 s.
  await host.advance(500)
  expect(polls()).toBe(2)
  expect(host.kept['events.seq']).toBe(11)
  expect(loop.status().failures).toBe(1)
  await host.advance(500)
  expect(polls()).toBe(2)

  // After the backoff a 410 whose resync throws: seq still 11, backoff grows.
  await host.advance(2_000)
  expect(polls()).toBe(3)
  expect(host.kept['events.seq']).toBe(11)
  expect(loop.status().failures).toBe(2)
  loop.stop()
})
