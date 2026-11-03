import { atom, read, update } from 'claude-code'
import type { EngineInterface, JsonValue, Register } from 'claude-code'

import type { NetView } from '../types'
import type { EngineReply, KeptGame, ViewProps, ViewRow } from './view-types'
import { chainEngines, isEngineRequest, noFallback } from './engine/engine'
import type { EngineRequest } from './engine/engine'
import { createStockfishEngine } from './engine/stockfish'
import { movetext } from './games/chess'
import { resolveServerUrl, uuidV4 } from './host'
import type { Host } from './host'
import type { OfflineGame, OfflineReason } from './net/protocol'
import { offlinePgn, resolveDataDir } from './offline/store'
import { cycleMark, stepRange, toJoinRequest } from './online/queue-form'
import { btn, emptyUi, offerTimeControl, onlineView, seg } from './online/ui'
import type { UiState } from './online/ui'
import { createSession, initialView } from './session'
import type { Session } from './session'

// terminal-games: the Games pane (arcade and chess, offline and online), the
// /games command and the online session.

const PANE = 'claude-games'
const TITLE = 'Games'

// Bump the tag when NetView's fields change.
const net = atom({ plugin: 'terminal-games', key: 'net' } as const, initialView(''), { shape: 'net-2' })

let session: Session | null = null
let ui: UiState = emptyUi()
let engine: ReturnType<typeof chainEngines> | null = null
let lastProps: ViewProps | null = null
let lastCols = 60
// The actions done, per view instance: the highest n seen.
const seenActs = new Map<string, number>()

// The arcade's best scores and unfinished games, kept in the store.
const BEST_KEY = 'best'
const GAMES_KEY = 'games'
const MAX_PARKED = 5
const MAX_NAMES = 20
const MAX_GAMES_CHARS = 200_000
let bests: Record<string, number> = {}
let games: Record<string, KeptGame> = {}
let isKeptRead = false

const readBests = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((one): one is [string, number] => Number.isFinite(one[1]) && one[1] > 0),
  )
}
const readNewBest = (data: unknown) => {
  const best = (data as { best?: { game?: unknown; score?: unknown } } | null)?.best
  if (!best || typeof best.game !== 'string' || best.game.length > 40) return null
  if (typeof best.score !== 'number' || !Number.isFinite(best.score)) return null
  return { game: best.game, score: best.score }
}
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 100_000
const readGames = (value: unknown): Record<string, KeptGame> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_NAMES) return null
  const kept: Record<string, KeptGame> = {}
  for (const [name, one] of entries) {
    if (name.length === 0 || name.length > 40) continue
    if (!one || typeof one !== 'object' || Array.isArray(one)) continue
    const { current = null, parked, tenths, level } = one as Record<string, unknown>
    if (!Array.isArray(parked)) continue
    kept[name] = {
      current: (current ?? null) as JsonValue | null,
      parked: parked.filter(g => g !== null && typeof g === 'object').slice(0, MAX_PARKED) as JsonValue[],
      ...(isCount(tenths) ? { tenths } : {}),
      ...(isCount(level) ? { level } : {}),
    }
  }
  try {
    if (JSON.stringify(kept).length > MAX_GAMES_CHARS) return null
  } catch {
    return null
  }

  return kept
}
const loadKept = async ($: EngineInterface) => {
  if (isKeptRead) return
  isKeptRead = true
  bests = readBests(await $.store.get(BEST_KEY).catch(() => undefined))
  games = readGames(await $.store.get(GAMES_KEY).catch(() => undefined)) ?? {}
}

const platformOf = async ($: EngineInterface): Promise<'windows' | 'mac' | 'linux'> => {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const home = (await $.env.get('HOME')) ?? ''

  return home.startsWith('/Users/') ? 'mac' : 'linux'
}

const HELP = [
  '/games            open the games pane',
  '/games login      sign in to play online (device code)',
  '/games logout     sign out',
  '/games status     account, server and offline games folder',
  '/games sync       upload offline games now',
].join('\n')

// The account rows at the top of the pane.
export const topRows = (v: NetView): ViewRow[] => {
  const who =
    v.phase === 'signed-in'
      ? `Signed in as ${v.username ?? '?'}${v.rating !== null ? ` (${v.rating})` : ''}`
      : v.phase === 'signing-in'
        ? 'Signing in...'
        : v.phase === 'upgrade'
          ? 'Update needed'
          : v.phase === 'unreachable'
            ? 'Offline (server not reachable)'
            : v.phase === 'starting'
              ? 'Starting...'
              : 'Offline: /games login to play online'
  const rows: ViewRow[] = []
  const first = [seg('GAMES ', { b: true }), seg(who, { dim: v.phase !== 'signed-in' })]
  if (v.phase === 'signed-out' || v.phase === 'unreachable') first.push(seg(' '), btn('login', 'login'))
  rows.push({ segs: first })
  if (v.login) {
    rows.push({ segs: [seg('Approve code '), seg(v.login.userCode, { b: true, c: 'claude' }), seg(' in your browser ')] })
    rows.push({
      segs: [seg(v.login.uriComplete, { dim: true }), ...(v.login.canOpen ? [seg(' '), btn('open', 'open-login')] : [])],
    })
  }
  if (v.message) rows.push({ segs: [seg(v.message, { c: 'warning' })] })
  const counts: string[] = []
  if (v.phase === 'signed-in') {
    counts.push(`Online games ${v.online.games}`)
    if (v.online.offersIn) counts.push(`offers ${v.online.offersIn}`)
    if (v.online.isQueued) counts.push('in the queue')
  }
  counts.push(`Offline games ${v.offline.files}${v.offline.pending ? ` (${v.offline.pending} not uploaded)` : ''}`)
  rows.push({ segs: [seg(counts.join(' · '), { dim: true })] })

  return rows
}

const REASON: Record<string, OfflineReason> = {
  checkmate: 'checkmate',
  stalemate: 'stalemate',
  'only kings left': 'insufficient_material',
  'move limit': 'max_plies',
}
const RESULT = { w: '1-0', b: '0-1', draw: '1/2-1/2' } as const

// A finished offline game as the view reported it, as the protocol's file.
export const offlineGameOf = (raw: unknown, now: number): OfflineGame | null => {
  const r = raw as Record<string, unknown> | null
  if (!r || !Array.isArray(r.moves) || !Array.isArray(r.sans)) return null
  const moves = r.moves.filter((m): m is string => typeof m === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))
  const sans = r.sans.filter((m): m is string => typeof m === 'string' && m.length <= 10)
  if (moves.length === 0 || moves.length !== r.moves.length || sans.length !== moves.length || moves.length > 1000) return null
  const result = RESULT[r.result as keyof typeof RESULT]
  const reason = REASON[String(r.reason)]
  const level = r.level
  if (!result || !reason || typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 10) return null
  const color = r.you === 'b' ? 'black' : 'white'
  const head = { clientId: uuidV4(), playedAt: new Date(now).toISOString(), color, engineLevel: level, result } as const

  return { ...head, reason, pgn: offlinePgn(head, movetext(sans)), moves }
}

type Act = { v: string; n: number; id: string; [k: string]: unknown }

const readActs = (data: unknown): Act[] => {
  const acts = (data as { acts?: unknown } | null)?.acts
  if (!Array.isArray(acts)) return []
  return acts.filter(
    (a): a is Act =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as Act).v === 'string' &&
      typeof (a as Act).n === 'number' &&
      typeof (a as Act).id === 'string' &&
      (a as Act).id.length <= 100,
  )
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Anything the pane draws that is not in the net atom changed: redraw.
async function bump($: EngineInterface): Promise<void> {
  await update($, net, v => ({ ...v, rev: v.rev + 1 }))
}

async function buildProps($: EngineInterface, bodyRows: number): Promise<ViewProps> {
  const v = await read($, net)
  const s = session
  const now = await $.clock.now()
  const online = s && v.phase === 'signed-in' ? onlineView(ui, s.online(), now, lastCols) : null
  lastProps = { top: topRows(v), online, bodyRows, best: bests, games, ...(lastProps?.engine ? { engine: lastProps.engine } : {}) }

  return lastProps
}

export const register: Register = (on, options) => {
  const serverUrl = resolveServerUrl(options.serverUrl)

  const refreshLobby = async () => {
    const s = session
    if (!s?.auth()) return
    const [lobby, friends] = await Promise.all([
      s.actions.lobby().catch(() => null),
      s.actions.friends().catch(() => null),
    ])
    ui = { ...ui, lobby: lobby ?? ui.lobby, friends: friends ?? ui.friends }
  }

  // One action from the view; its outcome lands in `ui.note`.
  const doAct = async (a: Act, now: number) => {
    const s = session
    if (!s) return
    const id = a.id
    const [verb, arg = ''] = [id.split(':')[0]!, id.slice(id.indexOf(':') + 1)]
    const game = ui.gameId
    try {
      if (id === 'login') return void (await s.login())
      if (id === 'open-login') return void (await s.openLoginUrl())
      if (id === 'mode:online') {
        ui = { ...ui, mode: 'online', note: null }
        return refreshLobby()
      }
      if (id === 'mode:offline') return void (ui = { ...ui, mode: 'offline' })
      if (id === 'offline') {
        const record = offlineGameOf(a.game, now)
        if (record) await s.saveOffline(record)
        return
      }
      ui = { ...ui, note: null }
      if (id === 'refresh' || id === 'back') {
        ui = { ...ui, gameId: id === 'back' ? null : ui.gameId }
        return refreshLobby()
      }
      if (verb === 'form') {
        const [dim, n] = arg.split(':')
        const i = Number(n)
        if (dim === 'clock') ui = { ...ui, form: cycleMark(ui.form, 'gameClocks', i) }
        if (dim === 'pm') ui = { ...ui, form: cycleMark(ui.form, 'perMove', i) }
        if (dim === 'range') ui = { ...ui, form: stepRange(ui.form, i < 0 ? -1 : 1) }
        // In the queue, the new wishes replace the old ones.
        if (s.online().queue) {
          const req = toJoinRequest(ui.form, s.online().me?.rating ?? 1200)
          if (!('error' in req)) await s.actions.joinQueue(req)
        }
        return
      }
      if (id === 'queue:join') {
        const req = toJoinRequest(ui.form, s.online().me?.rating ?? 1200)
        if ('error' in req) return void (ui = { ...ui, note: req.error })
        await s.actions.joinQueue(req)
        return refreshLobby()
      }
      if (id === 'queue:leave') {
        await s.actions.leaveQueue()
        return refreshLobby()
      }
      if (verb === 'offer') {
        await s.actions.sendOffer(arg, offerTimeControl(ui.form))
        const who = ui.lobby.find(e => e.userId === arg)?.username ?? 'them'
        return void (ui = { ...ui, note: `Offer sent to ${who}.` })
      }
      if (verb === 'accept') {
        const gameId = await s.actions.acceptOffer(arg)
        return void (ui = { ...ui, gameId })
      }
      if (verb === 'decline') return s.actions.declineOffer(arg)
      if (verb === 'open') {
        ui = { ...ui, gameId: arg }
        return s.actions.openGame(arg)
      }
      if (id === 'move') {
        const uci = typeof a.uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(a.uci) ? a.uci : null
        const gameId = typeof a.game === 'string' ? a.game : null
        if (!uci || !gameId) return
        try {
          await s.actions.move(gameId, uci)
        } finally {
          ui = { ...ui, rev: ui.rev + 1 }
        }
        return
      }
      if (id === 'resign' && game) return s.actions.resign(game)
      if (verb === 'draw' && game && (arg === 'offer' || arg === 'accept' || arg === 'decline')) return s.actions.draw(game, arg)
      if (id === 'chat' && game) {
        const thread = s.online().games[game]?.state.chatThreadId
        const text = typeof a.text === 'string' ? a.text.trim().slice(0, 500) : ''
        if (thread && text) await s.actions.sendChat(thread, text)
        return
      }
      if (id === 'friend') {
        const name = typeof a.text === 'string' ? a.text.trim().slice(0, 40) : ''
        if (!name) return
        const res = await s.actions.requestFriend(name)
        ui = { ...ui, note: res.status === 'accepted' ? `${res.user.username} is now your friend.` : `Friend request sent to ${res.user.username}.` }
        return refreshLobby()
      }
      if (verb === 'friend' && arg.startsWith('accept:')) {
        await s.actions.acceptFriend(arg.slice('accept:'.length))
        return refreshLobby()
      }
    } catch (error) {
      ui = { ...ui, note: errorText(error) }
    }
  }

  on('session.start', async ($, e, next) => {
    await loadKept($)
    await $.command.register({
      name: 'games',
      description: 'Games: open the pane, or login / logout / status / sync',
      argumentHint: '[login|logout|status|sync]',
    })
    session?.stop()
    ui = emptyUi()
    const dataDir = resolveDataDir(options.dataDir, {
      configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
      home: (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    })
    // The engine's `$` is never handed on as a value: each call is spelled
    // out here, and the logic gets this Host.
    const host: Host = {
      http: { fetch: (url, init) => $.http.fetch(url, init) },
      store: {
        get: key => $.store.get(key),
        set: (key, value) => $.store.set(key, value),
        delete: key => $.store.delete(key),
      },
      clock: {
        now: () => $.clock.now(),
        after: (ms, fn) => $.clock.after(ms, fn),
        every: (ms, fn) => $.clock.every(ms, fn),
      },
      fs: {
        read: path => $.fs.read(path),
        write: (path, text) => $.fs.write(path, text),
        list: path => $.fs.list(path),
        exists: path => $.fs.exists(path),
      },
      process: { run: (argv, init) => $.process.run(argv, init) },
    }
    engine = chainEngines(createStockfishEngine(host, `${$.plugin.root}/stockfish`), noFallback)
    const s = createSession({
      host,
      serverUrl,
      dataDir,
      platform: await platformOf($),
      setView: fn => update($, net, v => fn({ ...v, serverUrl })).then(() => undefined),
      toast: text => $.ui.toast(text),
      onMatch: gameId => {
        if (!ui.gameId) ui = { ...ui, gameId, mode: 'online' }
        void session?.actions.openGame(gameId).catch(() => undefined)
      },
    })
    session = s
    void s.start()
    void $.ui.open({ id: PANE, title: TITLE })
    // A running clock redraws each second; the lobby refreshes every 10 s.
    let beats = 0
    $.clock.every(1000, () => {
      beats++
      if (ui.mode !== 'online' || !s.auth()) return
      const g = ui.gameId ? s.online().games[ui.gameId] : undefined
      const isTicking = !!g && g.state.status === 'active' && (!!g.state.clock || !!g.moveDeadline)
      if (!ui.gameId && beats % 10 === 0) {
        void refreshLobby().then(() => bump($)).catch(() => undefined)
      } else if (isTicking) {
        void bump($).catch(() => undefined)
      }
    })

    return next(e)
  })

  on('session.end', ($, e, next) => {
    session?.stop()

    return next(e)
  })

  // What the view posts: a new best, its unfinished games, a chess position
  // for the engine, and actions (lobby, moves, chat, a finished offline
  // game). The answer is the next props.
  on('ui.message', async ($, e, next) => {
    let isChanged = false
    await loadKept($)
    const newBest = readNewBest(e.data)
    if (newBest && newBest.score > (bests[newBest.game] ?? 0)) {
      bests = { ...bests, [newBest.game]: newBest.score }
      await $.store.set(BEST_KEY, bests).catch(() => {})
      isChanged = true
    }
    const posted = (e.data as { games?: unknown } | null)?.games
    const kept = posted === undefined ? null : readGames(posted)
    if (kept && JSON.stringify(kept) !== JSON.stringify(games)) {
      games = kept
      await $.store.set(GAMES_KEY, games).catch(() => {})
    }
    const ask = (e.data as { engine?: unknown } | null)?.engine
    let reply: EngineReply | null = null
    if (isEngineRequest(ask) && engine) {
      const r = ask as EngineRequest
      const answer = await engine.move(r)
      reply = { fen: r.fen, level: r.level, move: answer.move }
      isChanged = true
    }
    const now = await $.clock.now()
    for (const a of readActs(e.data)) {
      if (a.n <= (seenActs.get(a.v) ?? 0)) continue
      seenActs.set(a.v, a.n)
      await doAct(a, now)
      isChanged = true
    }
    if (!isChanged) return next(e)
    if (reply && lastProps) lastProps = { ...lastProps, engine: reply }
    await bump($)
    const props = await buildProps($, lastProps?.bodyRows ?? 30)

    return { props: reply ? { ...props, engine: reply } : props }
  })

  on('command.run', { command: 'games' }, async ($, e) => {
    const s = session
    const arg = e.args.trim().toLowerCase()
    if (!s) return { text: 'Games is still starting; try again in a moment.' }
    switch (arg) {
      case '':
        await $.ui.open({ id: PANE, title: TITLE })
        return { text: 'Games pane opened.' }
      case 'login':
        void $.ui.open({ id: PANE, title: TITLE })
        return { text: await s.login() }
      case 'logout':
        return { text: await s.logout() }
      case 'status':
        return { text: s.status() }
      case 'sync':
        return { text: await s.sync() }
      default:
        return { text: HELP }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    lastCols = Math.max(20, e.props.bodyColumns)
    await loadKept($)
    const props = await buildProps($, e.props.scroll.bodyRows)
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)

      return <Client key="view" module="./games-view.tsx" props={props} width="100%" />
    }
    // Surfaces without a Client: the account and online rows as text.
    const { Box, Text } = $.ui.resolve(e)
    const rows = [...props.top, ...(props.online?.rows ?? [])]

    return (
      <Box flexDirection="column">
        {rows.map(r => (
          <Text>
            {r.segs.map(s => (
              <Text color={s.c || undefined} dimColor={s.dim} weight={s.b ? 'bold' : undefined}>
                {s.t}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })
}
