import { expect, mock, test } from 'claude-code/testing'

import { fakeServer } from './kit'
import { linesOf } from './lines'
import { replay } from '../hooks/games/chess'
import type { Reply, Sent } from './kit'

// Online play through the real plugin and its view: the lobby, an offer
// accepted, a move sent from the board, chat, resign, and an offline game
// against the computer saved as JSON.

const SERVER = 'https://arcade.skywars.fun'
const VIEW = 'view'
const PANE = {
  plugin: 'terminal-games',
  component: 'Pane',
  requestId: 'claude-games',
  surface: 'terminal',
  props: { title: 'Games', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const ME = {
  user: { id: 'me', username: 'luc', rating: 1214, role: 'USER', createdAt: '' },
  eventSeq: 10,
  activeGameIds: [],
  queue: null,
  serverTime: 1,
}
const player = (id: string, name: string, rating: number) => ({ kind: 'user', userId: id, username: name, rating, online: true })
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const gameState = (moves: { uci: string; san: string }[], extra: Record<string, unknown> = {}) => ({
  id: 'g1',
  mode: 'online',
  source: 'mod',
  timeControl: { gameClock: { initialMs: 300_000, incrementMs: 0 }, perMoveMs: null },
  engineLevel: null,
  rated: true,
  status: 'active',
  result: null,
  reason: null,
  white: player('me', 'luc', 1214),
  black: player('bob', 'bob', 1180),
  you: 'white',
  turn: moves.length % 2 ? 'black' : 'white',
  fen: START,
  plyCount: moves.length,
  lastMove: null,
  moveDeadlineAt: null,
  ratingDeltaWhite: null,
  ratingDeltaBlack: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  lastMoveAt: null,
  pgn: '',
  moves: moves.map((m, i) => ({ ply: i + 1, san: m.san, uci: m.uci, fenAfter: START, clockMs: null, at: '' })),
  clock: { initialMs: 300_000, incrementMs: 0, whiteMs: 300_000, blackMs: 300_000, running: moves.length ? 'black' : 'white', serverTime: 1 },
  serverTime: 1,
  drawOffer: null,
  inCheck: false,
  legalMoves: [],
  canMove: moves.length % 2 === 0,
  canResign: true,
  canAbort: false,
  canOfferDraw: true,
  canAcceptDraw: false,
  chatThreadId: 't1',
  eventSeq: 11,
  ...extra,
})
const OFFER = {
  id: 'o1',
  kind: 'queue',
  from: { userId: 'bob', username: 'bob', rating: 1180 },
  to: { userId: 'me', username: 'luc', rating: 1214 },
  timeControl: { gameClock: { initialMs: 300_000, incrementMs: 0 }, perMoveMs: null },
  fromColor: 'black',
  status: 'pending',
  createdAt: '',
  expiresAt: '',
  gameId: null,
}
const ENTRY = {
  userId: 'ann',
  username: 'ann',
  rating: 1250,
  since: '',
  ratingRange: { min: 1100, max: 1400 },
  gameClocks: { accepted: [null], preferred: [null] },
  perMove: { accepted: [180_000], preferred: [180_000] },
}

const world = (on: any, store: Record<string, unknown> = {}) => {
  const files: Record<string, string> = {}
  const toasts: string[] = []
  // C:/Users/t is not absolute on Linux, so the engine resolves it under the
  // cwd first: the fake keys on the part from C:/Users/t on.
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/')
    const at = s.indexOf('C:/Users/t/')
    return at > 0 ? s.slice(at) : s
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {
    ...store,
    clientInstanceId: '5d0f6c8e-3c1a-4c7e-9a51-0b8f0b6a2e11',
    auth: { serverUrl: SERVER, token: 'tok', userId: 'me', username: 'luc', obtainedAt: '' },
  })
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\t' })
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
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
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  let game = gameState([])
  const moves: Sent[] = []
  const chats: string[] = []
  const imports: unknown[] = []
  let queued: unknown = null
  let offers = { incoming: [OFFER], outgoing: [] as unknown[] }
  const server = fakeServer(on, {
    'GET /api/mod/version': () => ({ body: { apiVersion: 1, minModVersion: '0.1.0', latestModVersion: '0.1.0', serverTime: 1 } }),
    'GET /api/mod/me': () => ({ body: ME }),
    'GET /api/mod/offers': () => ({ body: offers }),
    'GET /api/mod/events': () => new Promise<Reply>(() => {}),
    'GET /api/mod/queue': () => ({ body: { entries: queued ? [ENTRY, queued] : [ENTRY], you: queued, serverTime: 1 } }),
    'POST /api/mod/queue': req => {
      queued = { ...ENTRY, userId: 'me', username: 'luc', rating: 1214, ...(req.body as object) }
      return { body: queued }
    },
    'GET /api/mod/friends': () => ({ body: { friends: [{ userId: 'bob', username: 'bob', rating: 1180, online: true, lastSeenAt: null, since: '' }], incoming: [], outgoing: [] } }),
    'POST /api/mod/offers/o1/accept': () => {
      offers = { incoming: [], outgoing: [] }
      return { body: game }
    },
    'GET /api/mod/games/g1': () => ({ body: game }),
    'POST /api/mod/games/g1/move': req => {
      moves.push(req)
      game = gameState([{ uci: 'e2e4', san: 'e4' }])
      return { body: { move: game.moves[0], game } }
    },
    'POST /api/mod/games/g1/resign': () => {
      game = gameState(game.moves.map(m => ({ uci: m.uci, san: m.san })), { status: 'finished', result: '0-1', reason: 'resign', ratingDeltaWhite: -12, canMove: false })
      return { body: game }
    },
    'GET /api/mod/chat/threads/t1/messages': () => ({
      body: { messages: [{ id: 'm1', threadId: 't1', kind: 'user', sender: { userId: 'bob', username: 'bob' }, text: 'good luck', system: null, at: '2026-11-04T10:00:01.000Z' }], nextBefore: null },
    }),
    'POST /api/mod/chat/threads/t1/read': () => ({ body: { unread: 0 } }),
    'POST /api/mod/chat/threads/t1/messages': req => {
      const text = (req.body as { text: string }).text
      chats.push(text)
      return { body: { id: `m${chats.length + 1}`, threadId: 't1', kind: 'user', sender: { userId: 'me', username: 'luc' }, text, system: null, at: '2026-11-04T10:00:09.000Z' } }
    },
    'POST /api/mod/offline/import': req => {
      imports.push(req.body)
      const games = (req.body as { games: { clientId: string }[] }).games
      return { body: { results: games.map(g => ({ clientId: g.clientId, status: 'created', gameId: 'x' })) } }
    },
  })

  return { files, toasts, clock, server, moves, chats, imports }
}

// The view's lines top to bottom, as drawn.
const lineList = async (ui: any): Promise<string[]> => linesOf(await ui.drawn({ in: VIEW }))
const text = async (ui: any) => (await lineList(ui)).join('\n')
const click = async (ui: any, w: any, x: number, y: number) => {
  await ui.pointer({ type: 'down', x, y, in: VIEW })
  await ui.pointer({ type: 'up', x, y, in: VIEW })
  await w.clock.settle()
}
// Clicks the run reading `label` on the first line matching `line`.
const press = async (ui: any, w: any, label: string, line: RegExp) => {
  const lines = await lineList(ui)
  const y = lines.findIndex(t => line.test(t) && t.includes(label))
  if (y < 0) throw new Error(`no ${label} on a line ${line}:\n${lines.join('\n')}`)
  await click(ui, w, lines[y]!.indexOf(label) + 1, y)
}
// Clicks square (file 0-7, rank 1-8) of the chess board, white at the bottom.
const square = async (ui: any, w: any, name: string) => {
  const lines = await lineList(ui)
  const top = lines.findIndex(l => l.startsWith('╭'))
  const scale = (lines[top]!.length - 2) / 16
  const cx = name.charCodeAt(0) - 97
  const cy = 8 - Number(name[1])
  await click(ui, w, 1 + cx * 2 * scale + scale, top + 1 + cy * scale + Math.floor(scale / 2))
}

const mountPane = async ($: any) => {
  const ui = await $.ui.mount(PANE)
  await ui.resize({ columns: 70, rows: 60, in: VIEW })
  return ui
}

test('online: lobby, queue, accept an offer, move on the board, chat, resign', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  const ui = await mountPane($)
  expect(await text(ui)).toMatch(/Signed in as luc \(1214\)/)

  // Chess is first; its mode row switches to the lobby.
  await press(ui, w, '[Online]', /\[vs Computer\]/)
  let all = await text(ui)
  expect(all).toMatch(/LOBBY 1 waiting/)
  expect(all).toContain('ann 1250 no clock · 3 min/move [offer]')
  expect(all).toMatch(/bob 1180 5\+0/)
  expect(all).toMatch(/● bob/)

  // Join the queue with the default form.
  await press(ui, w, '[join queue]', /join queue/)
  const joined = w.server.sent.find((s: Sent) => s.method === 'POST' && s.path === '/api/mod/queue')
  expect(joined?.body).toMatchObject({ ratingRange: { min: 1064, max: 1364 }, perMove: { accepted: [180_000] } })
  expect(await text(ui)).toMatch(/You are in the queue/)

  // Accept bob's offer: the board opens, white at the bottom, with clocks.
  await press(ui, w, '[accept]', /bob 1180/)
  all = await text(ui)
  expect(all).toMatch(/● bob 1180 online {2}5:00/)
  expect(all).toMatch(/○ luc \(you\) 1214 {2}5:00/)
  expect(all).toMatch(/Your move/)
  expect(all).toMatch(/bob: good luck/)
  expect(all).toMatch(/a +b +c +d +e +f +g +h/)

  // e2-e4 by two clicks: sent with the ply it expects; the answer shows.
  await square(ui, w, 'e2')
  await square(ui, w, 'e4')
  expect(w.moves.map(m => m.body)).toEqual([{ uci: 'e2e4', expectedPly: 0 }])
  all = await text(ui)
  expect(all).toMatch(/Moves 1\. e4/)
  expect(all).toMatch(/Opponent's move/)

  // Chat: C, type, Enter.
  await ui.key({ key: 'c', in: VIEW })
  for (const ch of 'gl hf') await ui.key({ key: ch === ' ' ? 'space' : ch, in: VIEW })
  await ui.key({ key: 'return', in: VIEW })
  await w.clock.settle()
  expect(w.chats).toEqual(['gl hf'])
  expect(await text(ui)).toMatch(/luc: gl hf/)

  // Resign: the result with the rating change.
  await press(ui, w, '[resign]', /resign/)
  expect(await text(ui)).toMatch(/You lost · resign \(-12\)/)
  expect((await text(ui)).match(/You lost · resign/g)?.length).toBe(1)
  await ui.unmount()
})

test('vs Computer: a finished game is written as JSON and uploaded', async ($, on) => {
  // A kept game one move from Scholar's mate comes back paused.
  const kept = replay(['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6'])
  const w = world(on, { games: { Chess: { current: kept, parked: [], level: 4 } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
  const ui = await mountPane($)
  expect(await text(ui)).toMatch(/Paused · Your move \(white\)/)
  expect(await text(ui)).toMatch(/level 4 · Club/)
  await square(ui, w, 'h5')
  await square(ui, w, 'f7')
  await w.clock.settle()
  expect(await text(ui)).toMatch(/Checkmate, you win!/)
  const saved = Object.entries(w.files).filter(([p]) => p.startsWith('C:/Users/t/.claude/terminal-games/games/'))
  expect(saved.length).toBe(1)
  const file = JSON.parse(saved[0]![1])
  expect(file).toMatchObject({ color: 'white', engineLevel: 4, result: '1-0', reason: 'checkmate' })
  expect(file.moves).toEqual(['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'])
  expect(file.pgn).toMatch(/1\. e4 e5 2\. Bc4 Nc6 3\. Qh5 Nf6 4\. Qxf7# 1-0$/)
  expect(w.imports.length).toBe(1)
  expect(w.toasts.some(t => /Uploaded 1 offline game/.test(t))).toBe(true)
  await ui.unmount()
})
