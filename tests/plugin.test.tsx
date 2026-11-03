import { expect, mock, test } from 'claude-code/testing'

import { fakeServer } from './kit'
import type { Reply } from './kit'

// The real plugin, driven as a session would: session.start, /games and
// the pane, with $.http.fetch, $.fs, $.store, $.clock, $.env and
// $.process.run answered by the test's hooks beneath it.

const SERVER = 'https://arcade.skywars.fun'
const PANE = {
  plugin: 'terminal-games',
  component: 'Pane',
  requestId: 'claude-games',
  props: {
    title: 'Games',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ME = {
  user: { id: 'cm3u1', username: 'luc', rating: 1214, role: 'USER', createdAt: '' },
  eventSeq: 48211,
  activeGameIds: [],
  queue: null,
  serverTime: 1,
}

const GAME_FILE = {
  clientId: '5d0f6c8e-3c1a-4c7e-9a51-0b8f0b6a2e11',
  playedAt: '2026-11-02T20:14:03.000Z',
  color: 'white',
  engineLevel: 4,
  result: '1-0',
  reason: 'checkmate',
  pgn: '[Event "Terminal Games offline"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
  moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'],
}
const DATA = 'C:/Users/t/.claude/terminal-games/games'

const world = (on: any, tokenReplies: Reply[]) => {
  const files: Record<string, string> = { [`${DATA}/20261102-201403-5d0f6c8e.json`]: JSON.stringify(GAME_FILE, null, 2) }
  const toasts: string[] = []
  // The engine hands paths on in the platform's spelling (backslashes on
  // Windows); the fake keeps forward slashes.
  const norm = (p: string) => p.replace(/\\/g, '/')
  const runs: string[][] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\t' })
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', () => ({}))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: norm(e.path) in files || Object.keys(files).some(p => p.startsWith(`${norm(e.path)}/`)),
  }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: Object.keys(files)
      .filter(p => p.startsWith(`${norm(e.path)}/`))
      .map(p => ({ name: p.slice(norm(e.path).length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: { path: string }) => (norm(e.path) in files ? { value: files[norm(e.path)] } : { deny: 'ENOENT' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const imports: unknown[] = []
  const server = fakeServer(on, {
    'GET /api/mod/version': () => ({ body: { apiVersion: 1, minModVersion: '0.1.0', latestModVersion: '0.1.0', serverTime: 1 } }),
    'POST /api/auth/device/code': () => ({
      body: {
        device_code: 'secret', user_code: 'WDJB-MJHT', verification_uri: `${SERVER}/device`,
        verification_uri_complete: `${SERVER}/device?user_code=WDJB-MJHT`, expires_in: 1800, interval: 5,
      },
    }),
    'POST /api/auth/device/token': () => tokenReplies.shift() ?? { status: 400, body: { error: 'authorization_pending' } },
    'GET /api/mod/me': () => ({ body: ME }),
    'GET /api/mod/offers': () => ({ body: { incoming: [], outgoing: [] } }),
    'GET /api/mod/events': () => new Promise<Reply>(() => {}),
    'POST /api/mod/offline/import': req => {
      imports.push(req.body)
      return { body: { results: [{ clientId: GAME_FILE.clientId, status: 'created', gameId: 'g_1' }] } }
    },
    'POST /api/mod/logout': () => ({ body: { ok: true } }),
  })

  return { files, toasts, runs, clock, server, imports }
}

const paneText = async ($: any) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text', in: 'view' })).map((t: { text: string }) => t.text).join('\n')
  await ui.unmount()
  return texts
}

test('starts signed out, lists offline games, answers /games status and help', async ($, on) => {
  const w = world(on, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()

  expect(w.server.sent[0]?.path).toBe('/api/mod/version')
  expect(w.server.sent[0]?.headers['X-Mod-Version']).toBe('0.1.0')
  const text = await paneText($)
  expect(text).toMatch(/Offline: \/games login to play online/)
  expect(text).toMatch(/Offline games 1 \(1 not uploaded\)/)

  const status = await $.command.run({ command: 'games', args: 'status' } as never)
  expect(status.text).toMatch(/Server: https:\/\/arcade\.skywars\.fun/)
  expect(status.text).toMatch(/Not signed in/)
  expect(status.text).toMatch(/C:\/Users\/t\/\.claude\/terminal-games\/games/)
  expect((await $.command.run({ command: 'games', args: 'what' } as never)).text).toMatch(/\/games login/)
})

test('/games login: code in the pane and a toast, approval, signed in, offline game uploaded, long-poll started', async ($, on) => {
  const w = world(on, [
    { status: 400, body: { error: 'authorization_pending' } },
    { body: { access_token: 'tok-1', token_type: 'Bearer', expires_in: 2592000, scope: '' } },
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()

  const run = await $.command.run({ command: 'games', args: 'login' } as never)
  expect(run.text).toBe(`Open ${SERVER}/device?user_code=WDJB-MJHT and approve code WDJB-MJHT`)
  expect(w.toasts).toContain(run.text)
  let text = await paneText($)
  expect(text).toMatch(/WDJB-MJHT/)
  expect(text).not.toMatch(/secret/)

  // The person asks to open the page: one argv, no shell.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The row under the code: the URL, then [open].
  const x = `${SERVER}/device?user_code=WDJB-MJHT`.length + 2
  await ui.pointer({ type: 'down', x, y: 2, in: 'view' })
  await ui.pointer({ type: 'up', x, y: 2, in: 'view' })
  await w.clock.settle()
  await ui.unmount()
  expect(w.runs).toEqual([['rundll32', 'url.dll,FileProtocolHandler', `${SERVER}/device?user_code=WDJB-MJHT`]])

  await w.clock.advance(5_000) // pending
  await w.clock.advance(5_000) // token
  await w.clock.settle()

  text = await paneText($)
  expect(text).toMatch(/Signed in as luc \(1214\)/)
  expect(text).toMatch(/Offline games 1$/m)
  expect(text).toMatch(/Online games 0/)
  expect(w.toasts).toContain('Signed in as luc.')
  expect(w.imports.length).toBe(1)
  const me = w.server.sent.find(s => s.path === '/api/mod/me')
  expect(me?.headers.Authorization).toBe('Bearer tok-1')
  const poll = w.server.sent.find(s => s.path === '/api/mod/events')
  expect(poll?.url).toBe(`${SERVER}/api/mod/events?since=48211&timeoutMs=20000`)
  expect(poll?.headers.Authorization).toBe('Bearer tok-1')
  // The token never lands in a file.
  expect(Object.values(w.files).some(t => t.includes('tok-1'))).toBe(false)

  expect((await $.command.run({ command: 'games', args: 'logout' } as never)).text).toBe('Signed out luc.')
  expect(w.server.last()?.path).toBe('/api/mod/logout')
  expect(w.server.last()?.headers.Authorization).toBe('Bearer tok-1')
  expect(await paneText($)).toMatch(/Offline: \/games login/)
})

test('a denied login says so and stays signed out', async ($, on) => {
  const w = world(on, [{ status: 400, body: { error: 'access_denied' } }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  await $.command.run({ command: 'games', args: 'login' } as never)
  await w.clock.advance(5_000)
  await w.clock.settle()
  expect(w.toasts).toContain('Login denied.')
  const text = await paneText($)
  expect(text).toMatch(/Login denied\./)
  expect(text).not.toMatch(/WDJB-MJHT/)
})
