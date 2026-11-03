import { expect, test } from 'claude-code/testing'

import { ensureClientId, isUuidV4, resolveServerUrl } from '../hooks/host'
import { ApiError, compareVersions, createClient, MOD_VERSION, NetworkError, UpgradeRequiredError } from '../hooks/net/client'
import { CLIENT_ID, memoryHost, rejection, SERVER } from './kit'
import type { Reply } from './kit'

test('every /api/mod request carries version, client id and bearer token', async () => {
  const host = memoryHost({
    'GET /api/mod/me': () => ({ body: { user: { id: 'u1', username: 'luc' } } }),
    'POST /api/mod/games/g%201/move': () => ({ body: { ok: 1 } }),
    'GET /api/mod/version': () => ({ body: { apiVersion: 1, minModVersion: '0.1.0', latestModVersion: '0.1.0' } }),
  })
  {
    const client = createClient(host, { serverUrl: `${SERVER}/`, clientId: CLIENT_ID, token: () => 'tok' })

    await client.me()
    expect(host.last()?.url).toBe(`${SERVER}/api/mod/me`)
    expect(host.last()?.headers).toMatchObject({
      'X-Mod-Version': MOD_VERSION,
      'X-Client-Id': CLIENT_ID,
      Authorization: 'Bearer tok',
    })
    expect(host.last()?.headers['Content-Type']).toBeUndefined()

    await client.move('g 1', { uci: 'e2e4', expectedPly: 0 })
    expect(host.last()?.method).toBe('POST')
    expect(host.last()?.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(host.last()?.body).toEqual({ uci: 'e2e4', expectedPly: 0 })

    await client.version()
    expect(host.last()?.headers.Authorization).toBeUndefined()
    expect(host.last()?.headers['X-Client-Id']).toBe(CLIENT_ID)
    expect(host.last()?.headers['X-Mod-Version']).toBe(MOD_VERSION)
  }
})

test('query strings: events since, game list status', async () => {
  const host = memoryHost({
    'GET /api/mod/events': () => ({ body: { events: [], seq: 5, more: false, serverTime: 0 } }),
    'GET /api/mod/games': () => ({ body: { games: [], nextCursor: null } }),
  })
  {
    const client = createClient(host, { serverUrl: SERVER, clientId: CLIENT_ID, token: () => 't' })
    await client.events(48211)
    expect(host.last()?.url).toBe(`${SERVER}/api/mod/events?since=48211&timeoutMs=20000`)
    await client.events(undefined, 0)
    expect(host.last()?.url).toBe(`${SERVER}/api/mod/events?timeoutMs=0`)
    await client.listGames({ status: ['active', 'waiting'], limit: 10 })
    expect(host.last()?.url).toBe(`${SERVER}/api/mod/games?status=active%2Cwaiting&limit=10`)
  }
})

test('426 stops all online traffic', async () => {
  const host = memoryHost({
    'GET /api/mod/me': () => ({
      status: 426,
      body: { error: 'upgrade_required', message: 'Update the mod', minVersion: '0.2.0' },
    }),
  })
  {
    const seen: (string | null)[] = []
    const client = createClient(host, {
      serverUrl: SERVER,
      clientId: CLIENT_ID,
      token: () => 't',
      onUpgradeRequired: e => seen.push(e.minVersion),
    })
    expect(await rejection(client.me())).toBeInstanceOf(UpgradeRequiredError)
    expect(seen).toEqual(['0.2.0'])
    expect(client.isUpgradeRequired).toBe(true)

    // The next call never reaches the network.
    const before = host.sent.length
    expect(await rejection(client.friends())).toBeInstanceOf(UpgradeRequiredError)
    expect(host.sent.length).toBe(before)
    expect(seen.length).toBe(1)
  }
})

test('/version naming a newer minimum counts as 426', async () => {
  const host = memoryHost({
    'GET /api/mod/version': () => ({ body: { apiVersion: 1, minModVersion: '9.0.0', latestModVersion: '9.0.0', serverTime: 1 } }),
  })
  {
    let upgraded = false
    const client = createClient(host, { serverUrl: SERVER, clientId: CLIENT_ID, onUpgradeRequired: () => (upgraded = true) })
    expect(await rejection(client.version())).toBeInstanceOf(UpgradeRequiredError)
    expect(upgraded).toBe(true)
  }
  expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  expect(compareVersions('0.1.9', '0.2.0')).toBe(-1)
  expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
})

test('401, error envelope, retry-after, rotated token, network error', async () => {
  let mode = '401'
  const host = memoryHost({
    'GET /api/mod/me': (): Reply =>
      mode === '401'
        ? { status: 401, body: { error: 'unauthorized', message: 'Signed out' } }
        : mode === '429'
          ? { status: 429, body: { error: 'rate_limited', message: 'slow' }, headers: { 'retry-after': '3' } }
          : mode === 'rotate'
            ? { body: { user: {} }, headers: { 'set-auth-token': 'new-token' } }
            : 'network-error',
  })
  {
    let unauthorized = 0
    const rotated: string[] = []
    const client = createClient(host, {
      serverUrl: SERVER,
      clientId: CLIENT_ID,
      token: () => 't',
      onUnauthorized: () => unauthorized++,
      onTokenRotated: t => rotated.push(t),
    })

    const e401 = (await rejection(client.me())) as ApiError
    expect(e401).toBeInstanceOf(ApiError)
    expect(e401.code).toBe('unauthorized')
    expect(e401.message).toBe('Signed out')
    expect(unauthorized).toBe(1)

    mode = '429'
    const e429 = (await rejection(client.me())) as ApiError
    expect(e429.status).toBe(429)
    expect(e429.retryAfterMs).toBe(3000)

    mode = 'rotate'
    expect(await rejection(client.me())).toBeNull()
    expect(rotated).toEqual(['new-token'])

    mode = 'down'
    expect(await rejection(client.me())).toBeInstanceOf(NetworkError)
  }
})

test('the client id is made once and kept', async () => {
  const host = memoryHost()
  {
    const first = await ensureClientId(host)
    expect(isUuidV4(first)).toBe(true)
    expect(await ensureClientId(host)).toBe(first)
    expect(await host.store.get('clientInstanceId')).toBe(first)
  }
})

test('server URL setting falls back to localhost', () => {
  expect(resolveServerUrl('')).toBe('http://localhost:3000')
  expect(resolveServerUrl('ftp://x')).toBe('http://localhost:3000')
  expect(resolveServerUrl(' https://games.example.com/ ')).toBe('https://games.example.com')
})
