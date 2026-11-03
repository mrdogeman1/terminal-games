import type { ClientModule, JsonValue } from 'claude-code'

import type { EngineAsk, EngineReply, KeptGame, OnlineBoard, ViewProps, ViewRow } from './view-types'
import { chess, replay } from './games/chess'
import type { Chess } from './games/chess'
import { GAMES } from './games/games'
import type { Dir, Kind, Look } from './games/games'

// The Games pane's view: the account rows, then the arcade (Chess, Snake,
// Pong, Bricks, Dodge). Chess plays the computer offline, or the online
// game the hooks module hands it; the online lobby and buttons are rows of
// text whose clickable runs post their `act` to the hooks module.

// `tenths`: the speed shown, in tenths (10 = 1.0x; absent: 10). `level`:
// a game with levels' level (absent: the game's default). `parked`: games
// put aside for a new one, newest first, to go back to.
type Save = {
  g: unknown
  isPaused: boolean
  best: number
  tenths?: number
  level?: number
  parked: unknown[]
}

// A clickable row as drawn: its y and its runs.
type ActRow = { y: number; row: ViewRow }

// Mutated while drawing and by the timer (no redraw needed): what the timer
// and the listeners need to know about the last layout.
type Layout = {
  isVisible: boolean
  headerY: number
  headerW: number
  modeY: number
  // The first board row's y, and the board's size in cells.
  boardY: number
  w: number
  h: number
  acc: number
  down: [number, number] | null
  scale: number
  speedY: number
  plusX: number
  newX: number
  backX: number
  backW: number
  storedText: string
  isDirty: boolean
  sinceStore: number
  outbox: Record<string, unknown>
  stored: Record<string, number>
  sincePost: number
  asked: EngineAsk | null
  askBeats: number
  reply: EngineReply | null
  rows: ActRow[]
  // This instance's id and its actions' count: the hooks module acts on
  // each (id, n) once, though posts in one frame repeat earlier ones.
  viewId: string
  n: number
  // The online game as replayed from the props (by its moves), with your
  // selection; and a move of yours sent, shown until the answer comes.
  online: { key: string; g: Chess } | null
  pending: { id: string; rev: number; g: Chess } | null
  letters: boolean
}

type Input = { kind: 'chat' | 'friend'; text: string }

type State = {
  idx: number
  saves: Save[]
  layout: Layout
  browse: number | null
  mode: 'offline' | 'online'
  input: Input | null
}

const BEAT_MS = 50
const BASE_TIMES = 3
const MIN_TENTHS = 1
const MAX_TICKS_PER_BEAT = 256
const tenthsOf = (save: Save | undefined) => save?.tenths ?? 10
const timesOf = (save: Save | undefined) => (BASE_TIMES * tenthsOf(save)) / 10
const POST_BEATS = 100
const STORE_BEATS = 40
const MAX_PARKED = 5
const CHESS = GAMES.findIndex(g => g.name === 'Chess')
const hasSpeed = (idx: number) => !GAMES[idx]?.size
const hasLevels = (idx: number) => !!GAMES[idx]?.levels
const hasKnob = (idx: number) => hasSpeed(idx) || hasLevels(idx)
const levelOf = (save: Save | undefined, idx: number) => save?.level ?? GAMES[idx]?.defaultLevel ?? 1
const ENGINE_WAIT_BEATS = 300
// A blank line, the header, two border rows and the status line.
const CHROME_ROWS = 5
const MIN_H = 6
const MAX_H = 12
const MIN_W = 8
const MAX_W = 20
const SWIPE = 6
const SCALES = [3, 2, 1]
const SLOTS = GAMES.length
const INPUT_MAX = 300

const KEY_DIR: Record<string, Dir> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
}

const plain = (t: string, c: string, dim = false): Look => ({ t, c, bg: '', dim, b: false })

const LOOK: Record<Kind, Look> = {
  empty: plain('· ', '', true),
  head: plain('██', 'claude'),
  body: plain('██', 'success'),
  food: plain('◆ ', 'error'),
  you: plain('██', 'claude'),
  cpu: plain('██', 'warning'),
  ball: plain('● ', 'text'),
  brick: plain('▓▓', 'suggestion'),
  rock: plain('▼ ', 'error'),
  flashGood: plain('░░', 'success'),
  flashBad: plain('░░', 'error'),
}

const boardRow = (cells: Look[]): Look[] => {
  const segs: Look[] = []
  for (const one of cells) {
    const last = segs[segs.length - 1]
    if (last && last.c === one.c && last.bg === one.bg && last.dim === one.dim && last.b === one.b) {
      last.t += one.t
    } else {
      segs.push({ ...one })
    }
  }

  return segs
}

const dims = (g: unknown) => g as { w: number; h: number }

const enlarge = (one: Look, k: number, line: number): Look => {
  const symbol = one.t.replace(/ +$/, '')
  const isMiddle = line === Math.floor(k / 2)

  return {
    ...one,
    t: isMiddle && symbol ? `${' '.repeat(k - 1)}${symbol}${' '.repeat(k)}` : ' '.repeat(2 * k),
  }
}

const isWhole = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi

const isPlayable = (idx: number, g: unknown) => {
  const game = GAMES[idx]
  if (!game || !g || typeof g !== 'object') return false
  try {
    const { w, h } = dims(g)
    const isSized = game.size
      ? w === game.size[0] && h === game.size[1]
      : isWhole(w, MIN_W, MAX_W) && isWhole(h, MIN_H, MAX_H)
    if (!isSized || game.isOver(g)) return false
    game.status(g)
    game.score(g)
    if (game.lookAt) game.lookAt(g, 0, 0)
    else game.kindAt(g, 0, 0)
    game.tray?.(g)
    if (!game.size) game.tick(g)
    // A kept chess game from before the move list was kept can't be saved.
    if (idx === CHESS && !Array.isArray((g as Chess).moves)) return false

    return true
  } catch {
    return false
  }
}

const restore = (idx: number, kept: KeptGame | undefined): Save => {
  const game = GAMES[idx]!
  const fresh: Save = { g: null, isPaused: false, best: 0, parked: [] }
  if (!kept || typeof kept !== 'object') return fresh
  const parked = Array.isArray(kept.parked) ? kept.parked.filter(g => isPlayable(idx, g)).slice(0, MAX_PARKED) : []
  const g = isPlayable(idx, kept.current) ? kept.current : null
  const isTenths = hasSpeed(idx) && isWhole(kept.tenths, MIN_TENTHS, 100_000)
  const isLevel = hasLevels(idx) && isWhole(kept.level, 1, game.levels?.length ?? 0)

  return {
    ...fresh,
    g,
    isPaused: g !== null,
    parked,
    ...(isTenths ? { tenths: kept.tenths } : {}),
    ...(isLevel ? { level: kept.level } : {}),
  }
}

// The act of the run at column x of a row, or ''.
const actAt = (row: ViewRow, x: number) => {
  let at = 0
  for (const s of row.segs) {
    if (x >= at && x < at + s.t.length) return s.act
    at += s.t.length
  }

  return ''
}

const MODE_ROW: ViewRow = {
  segs: [
    { t: '[vs Computer]', c: 'suggestion', dim: false, b: false, act: 'mode:offline' },
    { t: ' ', c: '', dim: false, b: false, act: '' },
    { t: '[Online]', c: 'suggestion', dim: false, b: false, act: 'mode:online' },
  ],
}

const GamesView: ClientModule<ViewProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const top = props.top
  const state: State = surface.state ?? {
    idx: 0,
    saves: GAMES.map((game, i) => restore(i, props.games?.[game.name])),
    browse: null,
    mode: 'offline',
    input: null,
    layout: {
      isVisible: false,
      headerY: 0,
      headerW: 0,
      modeY: -1,
      boardY: 0,
      w: 0,
      h: 0,
      acc: 0,
      down: null,
      scale: 1,
      speedY: -1,
      plusX: 0,
      newX: -1,
      backX: -1,
      backW: 0,
      storedText: '',
      isDirty: false,
      sinceStore: 0,
      outbox: {},
      stored: {},
      sincePost: 0,
      asked: null,
      askBeats: 0,
      reply: null,
      rows: [],
      viewId: Math.floor(Math.random() * 2 ** 31).toString(36),
      n: 0,
      online: null,
      pending: null,
      letters: false,
    },
  }
  const send = (s: State, data: Record<string, unknown>) => {
    s.layout.outbox = { ...s.layout.outbox, ...data }
    surface.post(s.layout.outbox as never)
  }
  // An action for the hooks module, kept with the beat's others.
  const act = (s: State, id: string, extra: Record<string, unknown> = {}) => {
    const at = s.layout
    at.n += 1
    const acts = (at.outbox.acts as unknown[] | undefined) ?? []
    send(s, { acts: [...acts, { v: at.viewId, n: at.n, id, ...extra }] })
  }
  const set = (patch: Partial<State>) => surface.setState({ ...(surface.state ?? state), ...patch })
  const isRunning = (save: Save | undefined, idx: number) => !!save?.g && !!GAMES[idx] && !GAMES[idx].isOver(save.g)
  const isOnlineChess = (s: State) => s.idx === CHESS && s.mode === 'online'
  const keptOf = (saves: Save[]) => {
    const kept: Record<string, KeptGame> = {}
    GAMES.forEach((game, i) => {
      const one = saves[i]
      if (!one) return
      const current = isRunning(one, i) ? one.g : null
      const isEmpty = current === null && one.parked.length === 0 && one.tenths === undefined && one.level === undefined
      if (isEmpty) return
      kept[game.name] = {
        current: current as JsonValue | null,
        parked: one.parked as JsonValue[],
        ...(one.tenths !== undefined ? { tenths: one.tenths } : {}),
        ...(one.level !== undefined ? { level: one.level } : {}),
      }
    })

    return kept
  }
  const persist = (s: State, saves: Save[]) => {
    const at = s.layout
    at.isDirty = false
    at.sinceStore = 0
    const kept = keptOf(saves)
    const text = JSON.stringify(kept)
    if (text === at.storedText) return
    at.storedText = text
    send(s, { games: kept })
  }
  // A finished offline chess game goes to the hooks module, which writes it
  // as JSON and uploads it when signed in.
  const reportChess = (s: State, g: Chess, level: number) => {
    if (!g.result || g.moves.length === 0) return
    act(s, 'offline', {
      game: { moves: g.moves, sans: g.sans, result: g.result, reason: g.reason, level, you: g.you },
    })
  }
  const setSave = (s: State, patch: Partial<Save>, isUrgent = false, also: Partial<State> = {}) => {
    const saves = s.saves.map((one, i) => (i === s.idx ? { ...one, ...patch } : one))
    set({ ...also, saves })
    const before = s.saves[s.idx]
    const after = saves[s.idx]
    const isPausing = !!after?.isPaused && !before?.isPaused
    const isEnding = isRunning(before, s.idx) && !!after?.g && !isRunning(after, s.idx)
    if (isEnding && s.idx === CHESS) reportChess(s, after!.g as Chess, levelOf(after, s.idx))
    if (isUrgent || isPausing || isEnding) persist(s, saves)
    else s.layout.isDirty = true
  }

  if (surface.state === undefined) {
    surface.every(BEAT_MS, () => {
      const s = surface.state
      if (!s) return
      s.layout.outbox = {}
      s.layout.sinceStore += 1
      if (s.layout.isDirty && s.layout.sinceStore >= STORE_BEATS) persist(s, s.saves)
      if (isOnlineChess(s)) return
      const save = s.saves[s.idx]
      const game = GAMES[s.idx]!
      if (s.browse !== null) return
      if (!save || !isRunning(save, s.idx) || save.isPaused) return
      if (!s.layout.isVisible) {
        setSave(s, { isPaused: true })
        return
      }
      const level = levelOf(save, s.idx)
      const fen = game.ask?.(save.g, level) ?? null
      if (fen !== null) {
        const { asked, reply } = s.layout
        let g = save.g
        if (reply && reply.fen === fen && reply.level === level) {
          if (reply.move) g = game.answer!(save.g, reply.move)
          if (g === save.g) g = game.tick(save.g, level)
        } else if (asked?.fen !== fen || asked.level !== level) {
          s.layout.asked = { fen, level }
          s.layout.askBeats = 0
          send(s, { engine: { fen, level } })
          return
        } else if (++s.layout.askBeats >= ENGINE_WAIT_BEATS) {
          g = game.tick(save.g, level)
        } else {
          return
        }
        s.layout.acc = 0
        setSave(s, { g })
        return
      }
      s.layout.acc += BEAT_MS
      s.layout.sincePost += 1
      const times = hasSpeed(s.idx) ? timesOf(save) : 1
      const waitFor = (one: unknown) => (game.delay?.(one) ?? game.speed) / times
      let g = save.g
      let n = 0
      while (s.layout.acc >= waitFor(g) && n < MAX_TICKS_PER_BEAT && !game.isOver(g)) {
        s.layout.acc -= waitFor(g)
        g = game.tick(g, hasSpeed(s.idx) ? tenthsOf(save) / 10 : level)
        n++
      }
      if (n === MAX_TICKS_PER_BEAT || game.isOver(g)) s.layout.acc = 0
      if (g === save.g) return
      const kept = s.layout.stored[game.name] ?? 0
      const best = Math.max(save.best, game.score(g))
      const isDue = game.isOver(g) || s.layout.sincePost >= POST_BEATS
      if (best > kept && isDue && game.hasBest !== false) {
        s.layout.sincePost = 0
        s.layout.stored = { ...s.layout.stored, [game.name]: best }
        send(s, { best: { game: game.name, score: best } })
      }
      setSave(s, { g, best })
    })
    surface.setState(state)
  }

  const swipe = (s: State, by: number) => {
    const save = s.saves[s.idx]
    const saves = s.saves.map((one, i) => (i === s.idx && isRunning(save, s.idx) ? { ...one, isPaused: true } : one))
    s.layout.acc = 0
    set({ saves, idx: (s.idx + by + SLOTS) % SLOTS, browse: null, input: null })
    persist(s, saves)
  }

  const isWorthKeeping = (save: Save, idx: number) => {
    const game = GAMES[idx]!
    return isRunning(save, idx) && (game.hasProgress?.(save.g) ?? true)
  }

  const newGame = (s: State) => {
    if (s.layout.w === 0 || isOnlineChess(s)) return
    const save = s.saves[s.idx]!
    const game = GAMES[s.idx]!
    const parked = isWorthKeeping(save, s.idx) ? [save.g, ...save.parked].slice(0, MAX_PARKED) : save.parked
    const seed = (Math.random() * 4294967296) >>> 0
    s.layout.acc = 0
    const fresh = game.init(s.layout.w, s.layout.h, seed)
    const g = save.g && game.carry ? game.carry(save.g, fresh) : fresh
    setSave(s, { g, isPaused: false, parked }, true)
  }

  const openBrowse = (s: State) => {
    if (isOnlineChess(s)) return
    const save = s.saves[s.idx]!
    if (save.parked.length === 0) return
    s.layout.acc = 0
    setSave(s, { isPaused: isRunning(save, s.idx) || save.isPaused }, false, { browse: 0 })
  }

  const stepBrowse = (s: State, by: number) => {
    const save = s.saves[s.idx]!
    const entries = [...(save.g ? [-1] : []), ...save.parked.map((_, i) => i)]
    const at = Math.max(0, entries.indexOf(s.browse ?? 0))
    set({ browse: entries[(at + by + entries.length) % entries.length]! })
  }

  const pickBrowsed = (s: State) => {
    const save = s.saves[s.idx]!
    const at = s.browse
    const chosen = at === null || at < 0 ? undefined : save.parked[at]
    if (chosen === undefined) return set({ browse: null })
    const rest = save.parked.filter((_, i) => i !== at)
    const parked = isWorthKeeping(save, s.idx) ? [save.g, ...rest].slice(0, MAX_PARKED) : rest
    s.layout.acc = 0
    setSave(s, { g: chosen, isPaused: false, parked }, true, { browse: null })
  }

  const play = (s: State) => {
    if (isOnlineChess(s)) return
    const save = s.saves[s.idx]!
    const game = GAMES[s.idx]!
    if (!isRunning(save, s.idx)) {
      const seed = (Math.random() * 4294967296) >>> 0
      s.layout.acc = 0
      const fresh = game.init(s.layout.w, s.layout.h, seed)
      const g = save.g && game.carry ? game.carry(save.g, fresh) : fresh
      setSave(s, { g, isPaused: false }, true)
    } else if (save.isPaused) {
      setSave(s, { isPaused: false })
    }
  }

  const pace = (s: State, by: number) => {
    if (isOnlineChess(s)) return
    const levels = hasLevels(s.idx) ? GAMES[s.idx]!.levels! : null
    if (levels) {
      const now = levelOf(s.saves[s.idx], s.idx)
      const next = Math.max(1, Math.min(levels.length, now + by))
      if (next !== now) setSave(s, { level: next })
      return
    }
    if (!hasSpeed(s.idx)) return
    const now = tenthsOf(s.saves[s.idx])
    const next = Math.max(MIN_TENTHS, now + by)
    if (next !== now) setSave(s, { tenths: next })
  }

  const setMode = (s: State, mode: 'offline' | 'online') => {
    if (s.mode === mode) return
    const save = s.saves[CHESS]!
    const saves =
      mode === 'online' && isRunning(save, CHESS)
        ? s.saves.map((one, i) => (i === CHESS ? { ...one, isPaused: true } : one))
        : s.saves
    set({ mode, saves, input: null, browse: null })
    act(s, `mode:${mode}`)
  }

  // --- The online game, from the props.
  const board: OnlineBoard | null = props.online?.board ?? null
  const layout = state.layout
  if (props.engine) layout.reply = props.engine
  let onlineG: Chess | null = null
  if (board) {
    const key = `${board.id}:${board.you}:${board.moves.join(' ')}`
    if (layout.online?.key !== key) {
      layout.online = { key, g: replay(board.moves, { you: board.you, isOnline: true, isLetters: layout.letters }) }
    }
    const p = layout.pending
    if (p && (p.id !== board.id || p.rev !== board.rev || board.moves.length >= p.g.moves.length)) layout.pending = null
    onlineG = layout.pending?.g ?? layout.online.g
    if (onlineG.isLetters !== layout.letters) onlineG = { ...onlineG, isLetters: layout.letters }
  } else {
    layout.online = null
    layout.pending = null
  }
  const canMoveOnline = !!board && board.canMove && !layout.pending

  // Plays a click (or Enter) on the online board: a finished move is sent.
  const onlineStep = (s: State, next: Chess) => {
    const at = s.layout
    if (!board || !at.online) return
    if (next.moves.length > at.online.g.moves.length) {
      at.pending = { id: board.id, rev: board.rev, g: { ...next, sel: -1, targets: [] } }
      act(s, 'move', { game: board.id, uci: next.moves[next.moves.length - 1] })
    } else {
      at.online = { ...at.online, g: next }
    }
    set({})
  }

  // --- What fits.
  const cols = surface.columns || 40
  const isChess = state.idx === CHESS
  const isOnline = isChess && state.mode === 'online'
  const onlineRows = isOnline ? (props.online?.rows ?? []) : []
  const inputRows = state.input ? 1 : 0
  const free = props.bodyRows - top.length - 1
  const game = GAMES[state.idx]!
  const isSpeedShown = !isOnline && hasKnob(state.idx)
  const hasTray = !!game.tray && (!isOnline || !!board)
  const hasCoords = isChess && (!isOnline || !!board)
  const modeRows = isChess ? 1 : 0
  const playerRows = isOnline && board ? 2 : 0
  const chrome = CHROME_ROWS + modeRows + playerRows + (isSpeedShown ? 1 : 0) + (hasTray ? 1 : 0) + (hasCoords ? 1 : 0)
  const fitW = Math.min(MAX_W, Math.floor((cols - 2) / 2))
  const fitH = Math.min(MAX_H, free - chrome)
  const save = state.saves[state.idx]!
  const browse = isOnline ? null : state.browse
  const g = isOnline ? onlineG : browse !== null && browse >= 0 ? (save.parked[browse] ?? save.g) : save.g
  const isLive = !isOnline && !!g && !game.isOver(g)
  const boardW = game.size?.[0] ?? (isLive ? dims(g).w : fitW)
  const boardH = game.size?.[1] ?? (isLive ? dims(g).h : fitH)
  // Room the online rows want under the board (some of them, at least).
  const wantRows = isOnline && board ? Math.min(onlineRows.length, 6) + inputRows : 0
  const ranksW = hasCoords ? 2 : 0
  const scale = game.size
    ? (SCALES.find(k => boardW * 2 * k + 2 + ranksW <= cols && free - chrome - wantRows >= boardH * k) ?? 1)
    : 1
  const isBoardShown = !isOnline || !!board
  const isVisible = isOnline
    ? true
    : boardW >= MIN_W && boardH >= MIN_H && (game.size ? boardW * 2 + 2 <= cols : boardW <= fitW) && free - chrome >= boardH * scale
  const headerW = Math.max(30, boardW * 2 * scale + 2)
  layout.isVisible = isVisible
  layout.headerY = top.length + 1
  layout.headerW = headerW
  layout.modeY = isChess ? layout.headerY + 1 : -1
  const contentY = layout.headerY + 1 + modeRows
  layout.boardY = contentY + (isOnline && board ? 1 : 0) + 1
  layout.w = isBoardShown ? boardW : 0
  layout.h = isBoardShown ? boardH : 0
  layout.scale = scale
  for (const [name, n] of Object.entries(props.best ?? {})) {
    if (n > (layout.stored[name] ?? 0)) layout.stored = { ...layout.stored, [name]: n }
  }
  // Under the board: bottom border, coordinates, your row (online), tray, status.
  const afterBoard = layout.boardY + boardH * scale + 1 + (hasCoords ? 1 : 0) + (isOnline && board ? 1 : 0) + (hasTray ? 1 : 0) + 1
  layout.speedY = isSpeedShown ? afterBoard : -1
  const levelNow = levelOf(save, state.idx)
  const paceText = hasLevels(state.idx)
    ? ` level ${levelNow} · ${game.levels![levelNow - 1]} `
    : ` speed ${(tenthsOf(save) / 10).toFixed(1)}× `
  layout.plusX = 3 + paceText.length
  const parkedN = isOnline ? 0 : save.parked.length
  let rowEnd = layout.plusX + 3
  layout.newX = isLive && browse === null && rowEnd + 6 <= cols ? rowEnd + 1 : -1
  if (layout.newX >= 0) rowEnd += 6
  const backText = [`[back ${parkedN}]`, `[◀${parkedN}]`].find(t => rowEnd + 1 + t.length <= cols)
  layout.backX = parkedN > 0 && backText ? rowEnd + 1 : -1
  layout.backW = backText?.length ?? 0

  // The rows a click may act on, by y.
  const onlineY = isOnline ? (board ? afterBoard : contentY) : -1
  const actRows: ActRow[] = top.map((row, y) => ({ y, row }))
  if (isChess) actRows.push({ y: layout.modeY, row: MODE_ROW })
  onlineRows.forEach((row, i) => actRows.push({ y: onlineY + i, row }))
  layout.rows = actRows

  surface.onPointer(e => {
    const s = surface.state ?? state
    const at = s.layout
    if (e.type === 'leave') {
      at.down = null
      const one = s.saves[s.idx]
      if (!isOnlineChess(s) && isRunning(one, s.idx) && !one!.isPaused) {
        const saves = s.saves.map((x, i) => (i === s.idx ? { ...x, isPaused: true } : x))
        set({ saves })
        persist(s, saves)
      }
      return
    }
    if (e.type === 'down') {
      at.down = [e.x, e.y]
      return
    }
    if (e.type !== 'up') return
    const start = at.down
    at.down = null
    if (!start) return
    // A clickable run (account, mode, lobby and game buttons).
    const hit = at.rows.find(r => r.y === e.y)
    if (hit && Math.abs(e.x - start[0]) < SWIPE) {
      const id = actAt(hit.row, e.x)
      if (id === 'mode:online' || id === 'mode:offline') return setMode(s, id === 'mode:online' ? 'online' : 'offline')
      if (id === 'input:chat' || id === 'input:friend') return set({ input: { kind: id === 'input:chat' ? 'chat' : 'friend', text: '' } })
      if (id) return act(s, id)
      return
    }
    if (!at.isVisible || start[1] < at.headerY) return
    const dx = e.x - start[0]
    if (Math.abs(dx) >= SWIPE) {
      swipe(s, dx < 0 ? 1 : -1)
    } else if (e.y === at.headerY) {
      if (e.x <= 2) swipe(s, -1)
      else if (e.x >= at.headerW - 3) swipe(s, 1)
    } else if (at.speedY >= 0 && e.y === at.speedY) {
      if (e.x <= 2) pace(s, -1)
      else if (e.x >= at.plusX && e.x <= at.plusX + 2) pace(s, 1)
      else if (at.newX >= 0 && e.x >= at.newX && e.x < at.newX + 5) newGame(s)
      else if (at.backX >= 0 && e.x >= at.backX && e.x < at.backX + at.backW) {
        if (s.browse === null) openBrowse(s)
        else stepBrowse(s, 1)
      }
    } else if (e.y >= at.boardY) {
      const cx = Math.floor((e.x - 1) / (2 * at.scale))
      const cy = Math.floor((e.y - at.boardY) / at.scale)
      const isOnBoard = cx >= 0 && cx < at.w && cy >= 0 && cy < at.h
      if (isOnlineChess(s)) {
        const og = at.pending?.g ?? at.online?.g
        if (og && isOnBoard && canMoveOnline) onlineStep(s, chess.click!(og, cx, cy))
        return
      }
      if (s.browse !== null) return pickBrowsed(s)
      const one = s.saves[s.idx]!
      const current = GAMES[s.idx]!
      if (current.click && isRunning(one, s.idx) && isOnBoard) {
        setSave(s, { g: current.click(one.g, cx, cy), isPaused: false })
      } else {
        play(s)
      }
    }
  })

  surface.onKey(e => {
    const s = surface.state ?? state
    // Typing a chat line or a friend's name takes every key.
    if (s.input) {
      const input = s.input
      if (e.key === 'return') {
        const text = input.text.trim()
        if (text) act(s, input.kind === 'chat' ? 'chat' : 'friend', { text })
        return set({ input: null })
      }
      if (e.key === 'backspace' || e.key === 'delete') return set({ input: { ...input, text: input.text.slice(0, -1) } })
      if (e.key === 'tab') return set({ input: null })
      const ch = e.key === 'space' ? ' ' : e.key
      if ([...ch].length === 1 && !e.ctrl && !e.meta && input.text.length < INPUT_MAX) {
        set({ input: { ...input, text: input.text + ch } })
      }
      return
    }
    if (e.key === '[' || (e.key === 'tab' && e.shift)) return swipe(s, -1)
    if (e.key === ']' || e.key === 'tab') return swipe(s, 1)
    if (s.idx === CHESS && e.key === 'o') return setMode(s, s.mode === 'online' ? 'offline' : 'online')
    if (isOnlineChess(s)) {
      const at = s.layout
      const og = at.pending?.g ?? at.online?.g
      if (e.key === 'g' || e.key === 'G') {
        at.letters = !at.letters
        if (at.online) at.online = { ...at.online, g: { ...at.online.g, isLetters: at.letters } }
        return set({})
      }
      if (e.key === 'c') return set({ input: { kind: 'chat', text: '' } })
      if (!og) return
      if (e.key === 'u' || e.key === 'U') return onlineStep(s, chess.other!(og, e.key))
      if (e.key === 'return' && canMoveOnline) return onlineStep(s, chess.press!(og))
      const dir = KEY_DIR[e.key]
      if (dir) onlineStep(s, chess.key(og, dir))
      return
    }
    if (!s.layout.isVisible) return
    if (s.browse !== null) {
      if (e.key === 'right' || e.key === 'b') stepBrowse(s, 1)
      else if (e.key === 'left') stepBrowse(s, -1)
      else if (['return', ' ', 'space'].includes(e.key)) pickBrowsed(s)
      else if (e.key === 'backspace' || e.key === 'delete') set({ browse: null })
      return
    }
    if (e.key === 'n') return newGame(s)
    if (e.key === 'b') return openBrowse(s)
    const one = s.saves[s.idx]!
    if (e.key === ' ' || e.key === 'space' || e.key === 'p') {
      if (isRunning(one, s.idx) && !one.isPaused) setSave(s, { isPaused: true })
      else play(s)
      return
    }
    if (hasKnob(s.idx) && (e.key === '-' || e.key === '_')) return pace(s, -1)
    if (hasKnob(s.idx) && (e.key === '+' || e.key === '=')) return pace(s, 1)
    const current = GAMES[s.idx]!
    if (e.key === 'return' && current.press) {
      if (isRunning(one, s.idx)) setSave(s, { g: current.press(one.g), isPaused: false })
      else play(s)
      return
    }
    if (current.other && one.g && !KEY_DIR[e.key]) {
      const next = current.other(one.g, e.key)
      if (next !== one.g) setSave(s, { g: next })
      return
    }
    const dir = KEY_DIR[e.key]
    if (!dir || !isRunning(one, s.idx)) return
    setSave(s, { g: current.key(one.g, dir), isPaused: false })
  })

  // --- Drawing.
  const dots = Array.from({ length: SLOTS }, (_, i) => (i === state.idx ? '●' : '○')).join('')
  const title = `${game.name} ${dots}`
  const inner = Math.max(title.length, headerW - 4)
  const leftPad = Math.floor((inner - title.length) / 2)
  const header = `◀ ${' '.repeat(leftPad)}${title}${' '.repeat(inner - title.length - leftPad)} ▶`

  const best =
    game.hasBest === false
      ? ''
      : ` · best ${(n => (game.showScore ? game.showScore(n) : n))(Math.max(save.best, layout.stored[game.name] ?? 0))}`
  const status = isOnline
    ? board
      ? `${board.status}${!board.isOver && onlineG && onlineG.promo !== 'Q' ? ` · promotes to ${onlineG.promo}` : ''}`
      : ''
    : browse !== null
      ? `${browse < 0 ? 'Current game' : `Saved game ${browse + 1}/${parkedN}`} · ←→ · ↵ play · ⌫ back`
      : !g
        ? `Click to play · ${game.help}${parkedN > 0 ? ' · b = back' : ''}`
        : game.isOver(g)
          ? `Game over · ${game.status(g)}${best} · space = again${parkedN > 0 ? ' · b = back' : ''}`
          : save.isPaused
            ? `Paused · ${game.status(g)} · click or space`
            : `${game.status(g)}${best} · space = pause`

  const shownGame = isOnline ? onlineG : (g ?? (game.size ? game.init(boardW, boardH, 1) : null))
  const cellAt = (x: number, y: number): Look =>
    game.lookAt ? game.lookAt(shownGame, x, y) : LOOK[game.kindAt(shownGame, x, y)]
  const isShown = !!shownGame && dims(shownGame).w === boardW && dims(shownGame).h === boardH
  const tray: Look[] = []
  if (hasTray && shownGame) {
    let room = headerW - 2
    for (const one of game.tray?.(shownGame) ?? []) {
      if (room <= 0) break
      const t = one.t.slice(0, room)
      tray.push({ ...one, t })
      room -= t.length
    }
  }
  const youBlack = isChess && (shownGame as Chess | null)?.you === 'b'
  const rows = Array.from({ length: boardH * scale }, (_, r) => {
    const y = Math.floor(r / scale)
    const cells = Array.from({ length: boardW }, (_, x) => (isShown ? cellAt(x, y) : LOOK.empty))

    return boardRow(scale === 1 ? cells : cells.map(one => enlarge(one, scale, r % scale)))
  })
  const rankOf = (r: number) => {
    if (r % scale !== Math.floor(scale / 2)) return ' '
    const y = Math.floor(r / scale)
    return String(youBlack ? y + 1 : 8 - y)
  }
  const files = (youBlack ? 'hgfedcba' : 'abcdefgh')
    .split('')
    .map(f => `${' '.repeat(scale - 1)}${f}${' '.repeat(scale)}`)
    .join('')

  const drawRow = (r: ViewRow, key?: string) => (
    <Text key={key}>
      {r.segs.length === 0
        ? ' '
        : r.segs.map(s => (
            <Text color={s.c || undefined} dimColor={s.dim} weight={s.b ? 'bold' : undefined}>
              {s.t.slice(0, Math.max(1, cols))}
            </Text>
          ))}
    </Text>
  )
  const modeRow: ViewRow = {
    segs: MODE_ROW.segs.map(s => ({
      ...s,
      b: s.act === `mode:${state.mode}`,
      c: s.act === `mode:${state.mode}` ? 'claude' : 'suggestion',
    })),
  }
  const inputRow = state.input ? (
    <Text key="input">
      <Text color="claude">{state.input.kind === 'chat' ? 'Say: ' : 'Friend username: '}</Text>
      <Text>{`${state.input.text.slice(-(cols - 22))}▏`}</Text>
      <Text dimColor> ↵ send · tab cancel</Text>
    </Text>
  ) : null

  return (
    <Box flexDirection="column" width="100%">
      {top.map((r, i) => drawRow(r, `top-${i}`))}
      {isVisible && (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">{header}</Text>
          {isChess && drawRow(modeRow, 'mode')}
          {isOnline && board && drawRow(board.above, 'above')}
          {isBoardShown && (
            <Box flexDirection="row">
              <Box flexDirection="column" borderStyle="round" borderDimColor width={boardW * 2 * scale + 2}>
                {rows.map(segs => (
                  <Text>
                    {segs.map(s => (
                      <Text color={s.c || undefined} backgroundColor={s.bg || undefined} dimColor={s.dim} weight={s.b ? 'bold' : undefined}>
                        {s.t}
                      </Text>
                    ))}
                  </Text>
                ))}
              </Box>
              {hasCoords && (
                <Box flexDirection="column" paddingTop={1}>
                  {rows.map((_, r) => (
                    <Text dimColor>{` ${rankOf(r)}`}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {hasCoords && <Text dimColor>{` ${files}`}</Text>}
          {isOnline && board && drawRow(board.below, 'below')}
          {hasTray && (
            <Text key="tray">
              {tray.length === 0
                ? ' '
                : tray.map(s => (
                    <Text color={s.c || undefined} backgroundColor={s.bg || undefined} weight={s.b ? 'bold' : undefined}>
                      {s.t}
                    </Text>
                  ))}
            </Text>
          )}
          {isBoardShown && <Text dimColor>{status.slice(0, Math.max(10, cols))}</Text>}
          {isSpeedShown && (
            <Text>
              <Text color="suggestion">[−]</Text>
              <Text dimColor>{paceText}</Text>
              <Text color="suggestion">[+]</Text>
              {layout.newX >= 0 && <Text color="suggestion"> [new]</Text>}
              {layout.backX >= 0 && <Text color="suggestion">{` ${backText}`}</Text>}
            </Text>
          )}
          {isOnline && !props.online && <Text dimColor>Sign in to play online: /games login</Text>}
          {onlineRows.map((r, i) => drawRow(r, `on-${i}`))}
          {inputRow}
        </Box>
      )}
    </Box>
  )
}

export default GamesView
