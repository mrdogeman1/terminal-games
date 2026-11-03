import { atom, read, update } from 'claude-code'
import type { EngineInterface, JsonValue, Register } from 'claude-code'

import type { EngineReply, KeptGame, ViewProps } from './view-types'
import { chainEngines, isEngineRequest, noFallback } from './engine/engine'
import type { EngineRequest } from './engine/engine'
import { createStockfishEngine } from './engine/stockfish'
import { resolveServerUrl } from './host'
import type { Host } from './host'
import { resolveDataDir } from './offline/store'
import { createPane, topRows } from './pane'
import { createSession, initialView } from './session'
import type { Session } from './session'

// terminal-games: the Games pane (arcade and chess, offline and online), the
// /games command and the online session.

const PANE = 'claude-games'
const TITLE = 'Games'

// Bump the tag when NetView's fields change.
const net = atom({ plugin: 'terminal-games', key: 'net' } as const, initialView(''), { shape: 'net-2' })

let session: Session | null = null
const pane = createPane(() => session)
let engine: ReturnType<typeof chainEngines> | null = null
let lastProps: ViewProps | null = null
let lastCols = 60

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

// Anything the pane draws that is not in the net atom changed: redraw.
async function bump($: EngineInterface): Promise<void> {
  await update($, net, v => ({ ...v, rev: v.rev + 1 }))
}

async function buildProps($: EngineInterface, bodyRows: number): Promise<ViewProps> {
  const v = await read($, net)
  const s = session
  const now = await $.clock.now()
  const online = s ? pane.online(v, now, lastCols) : null
  lastProps = { top: topRows(v), online, bodyRows, best: bests, games, ...(lastProps?.engine ? { engine: lastProps.engine } : {}) }

  return lastProps
}

export const register: Register = (on, options) => {
  const serverUrl = resolveServerUrl(options.serverUrl)

  on('session.start', async ($, e, next) => {
    await loadKept($)
    await $.command.register({
      name: 'games',
      description: 'Games: open the pane, or login / logout / status / sync',
      argumentHint: '[login|logout|status|sync]',
    })
    session?.stop()
    pane.reset()
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
      onMatch: gameId => pane.onMatch(gameId),
    })
    session = s
    void s.start()
    void $.ui.open({ id: PANE, title: TITLE })
    // A running clock redraws each second; the lobby refreshes every 10 s.
    let beats = 0
    $.clock.every(1000, () => {
      beats++
      const ui = pane.ui()
      if (ui.mode !== 'online' || !s.auth()) return
      const g = ui.gameId ? s.online().games[ui.gameId] : undefined
      const isTicking = !!g && g.state.status === 'active' && (!!g.state.clock || !!g.moveDeadline)
      if (!ui.gameId && beats % 10 === 0) {
        void pane.refreshLobby().then(() => bump($)).catch(() => undefined)
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
    if (await pane.acts(e.data, now)) isChanged = true
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
