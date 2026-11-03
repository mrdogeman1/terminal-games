import { expect, test } from 'claude-code/testing'

import { isSafeVerificationUrl, openUrlArgv, startDeviceLogin } from '../hooks/net/device'
import type { DeviceLoginEnd } from '../hooks/net/device'
import type { DeviceCodeResponse } from '../hooks/net/protocol'
import { CLIENT_ID, memoryHost, SERVER } from './kit'
import type { Reply } from './kit'

const CODE: DeviceCodeResponse = {
  device_code: 'dev-secret',
  user_code: 'WDJB-MJHT',
  verification_uri: `${SERVER}/device`,
  verification_uri_complete: `${SERVER}/device?user_code=WDJB-MJHT`,
  expires_in: 1800,
  interval: 5,
}
const ME = {
  user: { id: 'cm3u1', username: 'luc', rating: 1214, role: 'USER', createdAt: '' },
  eventSeq: 48211,
  activeGameIds: [],
  queue: null,
  serverTime: 1,
}
const oauth = (error: string): Reply => ({ status: 400, body: { error, error_description: `about ${error}` } })

const setup = (tokenReplies: Reply[]) => {
  const host = memoryHost({
    'POST /api/auth/device/code': () => ({ body: CODE }),
    'POST /api/auth/device/token': () => tokenReplies.shift() ?? oauth('authorization_pending'),
    'GET /api/mod/me': req =>
      req.headers.Authorization === 'Bearer the-token' ? { body: ME } : { status: 401, body: { error: 'unauthorized', message: 'no' } },
  })
  const ends: DeviceLoginEnd[] = []
  const codes: string[] = []
  const tokenPolls = () => host.sent.filter(s => s.path === '/api/auth/device/token')
  const run = () =>
    startDeviceLogin(host, {
      serverUrl: SERVER,
      clientId: CLIENT_ID,
      onCode: c => void codes.push(c.user_code),
      onEnd: e => void ends.push(e),
    })

  return { host, ends, codes, tokenPolls, run }
}

test('happy path: code, pending, slow_down (+5 s), token, /me, auth stored', async () => {
  const t = setup([oauth('authorization_pending'), oauth('slow_down'), { status: 503, body: {} }, { body: { access_token: 'the-token', token_type: 'Bearer', expires_in: 2592000, scope: '' } }])
  const login = await t.run()
  expect(login.code.user_code).toBe('WDJB-MJHT')
  expect(t.codes).toEqual(['WDJB-MJHT'])
  expect(t.host.sent[0]?.body).toEqual({ client_id: 'claude-games' })
  expect(t.host.sent[0]?.headers.Authorization).toBeUndefined()

  // Nothing before the first interval.
  await t.host.advance(4_900)
  expect(t.tokenPolls().length).toBe(0)
  await t.host.advance(100) // 5 s: pending
  expect(t.tokenPolls().length).toBe(1)
  expect(t.tokenPolls()[0]?.body).toEqual({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: 'dev-secret',
    client_id: 'claude-games',
  })
  await t.host.advance(5_000) // 10 s: slow_down, interval now 10 s
  expect(t.tokenPolls().length).toBe(2)
  await t.host.advance(5_000) // 15 s: too early
  expect(t.tokenPolls().length).toBe(2)
  await t.host.advance(5_000) // 20 s: 503, not terminal
  expect(t.tokenPolls().length).toBe(3)
  expect(t.ends).toEqual([])
  await t.host.advance(10_000) // 30 s: token
  expect(t.tokenPolls().length).toBe(4)

  expect(t.ends.length).toBe(1)
  const end = t.ends[0]!
  expect(end.kind).toBe('signed-in')
  expect(t.host.kept.auth).toMatchObject({ serverUrl: SERVER, token: 'the-token', userId: 'cm3u1', username: 'luc' })
  const me = t.host.sent.find(s => s.path === '/api/mod/me')
  expect(me?.headers['X-Client-Id']).toBe(CLIENT_ID)

  // Polling has stopped.
  await t.host.advance(60_000)
  expect(t.tokenPolls().length).toBe(4)
})

test('denial stops at once and stores nothing', async () => {
  const t = setup([oauth('authorization_pending'), oauth('access_denied')])
  await t.run()
  await t.host.advance(10_000)
  expect(t.ends.map(e => e.kind)).toEqual(['denied'])
  expect(t.host.kept.auth).toBeUndefined()
  await t.host.advance(30_000)
  expect(t.tokenPolls().length).toBe(2)
})

test('expired code and other errors end the flow', async () => {
  const a = setup([oauth('expired_token')])
  await a.run()
  await a.host.advance(5_000)
  expect(a.ends[0]?.kind).toBe('expired')

  const b = setup([oauth('invalid_grant')])
  await b.run()
  await b.host.advance(5_000)
  expect(b.ends[0]).toMatchObject({ kind: 'error' })
  expect((b.ends[0] as { message: string }).message).toMatch(/about invalid_grant/)

  // Past expires_in without an answer: expired, without another poll.
  const c = setup([])
  await c.run()
  await c.host.advance(1_800_000)
  expect(c.ends[0]?.kind).toBe('expired')
})

test('cancel stops polling', async () => {
  const t = setup([])
  const login = await t.run()
  login.cancel()
  await t.host.settle()
  await t.host.advance(20_000)
  expect(t.tokenPolls().length).toBe(0)
  expect(t.ends.map(e => e.kind)).toEqual(['cancelled'])
})

test('only same-origin https (or localhost http) URLs are opened, as one argument', () => {
  expect(isSafeVerificationUrl(`${SERVER}/device?user_code=A`, SERVER)).toBe(true)
  expect(isSafeVerificationUrl('https://evil.example/device', SERVER)).toBe(false)
  expect(isSafeVerificationUrl('http://games.example.com/device', SERVER)).toBe(false)
  expect(isSafeVerificationUrl('http://localhost:3000/device', 'http://localhost:3000')).toBe(true)
  expect(isSafeVerificationUrl('javascript:alert(1)', SERVER)).toBe(false)
  expect(openUrlArgv('https://x/a?b=1&c=2', 'windows')).toEqual(['rundll32', 'url.dll,FileProtocolHandler', 'https://x/a?b=1&c=2'])
  expect(openUrlArgv('https://x', 'mac')).toEqual(['open', 'https://x'])
})
