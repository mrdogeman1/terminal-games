import type { OnlineBoard, ViewRow, ViewSeg } from '../view-types'
import type { Color, FriendsResponse, GameState, LobbyEntry, TimeControl } from '../net/protocol'
import {
  GAME_CLOCKS,
  PER_MOVE,
  defaultQueueForm,
  formatMs,
  gameClockLabel,
  perMoveLabel,
  timeControlLabel,
} from './queue-form'
import type { Mark, QueueForm } from './queue-form'
import { clockView, incomingOffers, opponentOf, outgoingOffers, tierOf } from './reducer'
import type { OnlineGame, OnlineState } from './reducer'

// The online part of the pane as rows of text with clickable runs: the
// lobby (queue form, waiting players, offers, your games, friends) or, with
// a game open, its board, moves, buttons and chat. Pure: the hooks module
// builds it from the online mirror and this UI state, the view draws it and
// posts a run's `act` when it is clicked.

export type UiState = {
  // The chess slot's mode, as the view last said.
  mode: 'offline' | 'online'
  // The online game on the board, or null for the lobby.
  gameId: string | null
  form: QueueForm
  lobby: LobbyEntry[]
  friends: FriendsResponse | null
  // Bumped with every answer to a move the view sent.
  rev: number
  // The last action's outcome, shown under the rows until the next one.
  note: string | null
}

export const emptyUi = (): UiState => ({
  mode: 'offline',
  gameId: null,
  form: defaultQueueForm(),
  lobby: [],
  friends: null,
  rev: 0,
  note: null,
})

type Style = { c?: string; dim?: boolean; b?: boolean; act?: string }

export const seg = (t: string, s: Style = {}): ViewSeg => ({
  t,
  c: s.c ?? '',
  dim: s.dim ?? false,
  b: s.b ?? false,
  act: s.act ?? '',
})
export const btn = (label: string, act: string): ViewSeg => seg(`[${label}]`, { c: 'suggestion', act })
const row = (...segs: ViewSeg[]): ViewRow => ({ segs })

// Segments laid into rows of at most `width` columns, breaking between
// segments (a segment longer than the row is cut).
export const wrap = (segs: ViewSeg[], width: number, indent = ''): ViewRow[] => {
  const rows: ViewRow[] = []
  let cur: ViewSeg[] = []
  let used = 0
  for (const one of segs) {
    const len = one.t.length
    if (used > 0 && used + len > width) {
      rows.push({ segs: cur })
      cur = indent ? [seg(indent)] : []
      used = indent.length
      if (one.t.trim() === '') continue
    }
    const t = len > width - used ? one.t.slice(0, Math.max(1, width - used)) : one.t
    cur.push({ ...one, t })
    used += t.length
  }
  if (cur.length) rows.push({ segs: cur })

  return rows
}

const MARK: Record<Mark, string> = { off: ' ', accepted: '·', preferred: '*' }
const markSeg = (mark: Mark, label: string, act: string) =>
  seg(`[${MARK[mark]}${label}]`, {
    act,
    c: mark === 'preferred' ? 'success' : mark === 'accepted' ? 'suggestion' : '',
    dim: mark === 'off',
    b: mark === 'preferred',
  })

const TIER: Record<string, string> = { beginner: 'Beginner', casual: 'Casual', club: 'Club', expert: 'Expert' }

const rangeLabel = (form: QueueForm) => (form.range === 'any' ? 'any rating' : `±${form.range}`)

// A lobby entry's wishes in short: its preferred options, else accepted.
const wishes = (e: LobbyEntry) => {
  const clocks = e.gameClocks.preferred.length ? e.gameClocks.preferred : e.gameClocks.accepted
  const moves = e.perMove.preferred.length ? e.perMove.preferred : e.perMove.accepted
  const clock = clocks.map(c => gameClockLabel(c)).join('/')
  const move = moves.map(m => perMoveLabel(m)).join('/')

  return `${clock} · ${move}`
}

// The time control an offer from this form proposes: the first preferred
// option of each kind, else the first accepted one.
export const offerTimeControl = (form: QueueForm): TimeControl => {
  const first = <T>(options: readonly T[], marks: Mark[]): T | null => {
    const at = marks.indexOf('preferred') >= 0 ? marks.indexOf('preferred') : marks.indexOf('accepted')
    return at >= 0 ? (options[at] ?? null) : null
  }

  return {
    gameClock: first(GAME_CLOCKS, form.gameClocks),
    perMoveMs: first(PER_MOVE, form.perMove),
  }
}

const side = (c: Color): 'w' | 'b' => (c === 'white' ? 'w' : 'b')
const reasonText = (r: string | null) => (r ? r.replace(/_/g, ' ') : '')

export const resultText = (g: GameState): string => {
  if (g.status === 'aborted') return 'Aborted'
  if (!g.result) return 'Game over'
  const delta = g.you === 'white' ? g.ratingDeltaWhite : g.ratingDeltaBlack
  const rating = delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta})`
  const why = g.reason ? ` · ${reasonText(g.reason)}` : ''
  if (g.result === '1/2-1/2') return `Draw${why}${rating}`
  const isWin = (g.result === '1-0') === (g.you === 'white')

  return `${isWin ? 'You won' : 'You lost'}${why}${rating}`
}

const playerRow = (g: OnlineGame, color: Color, now: number, isYou: boolean): ViewRow => {
  const p = color === 'white' ? g.state.white : g.state.black
  const c = clockView(g, now)
  const ms = color === 'white' ? c.whiteMs : c.blackMs
  const isRunning = c.running === color
  const name = isYou ? `${p.username ?? 'You'} (you)` : (p.username ?? (p.kind === 'engine' ? 'Computer' : 'Guest'))
  const segs = [
    seg(color === 'white' ? '○ ' : '● ', { dim: true }),
    seg(name, { b: isYou }),
    seg(p.rating !== null ? ` ${p.rating}` : '', { dim: true }),
  ]
  if (!isYou && p.online !== null) segs.push(seg(p.online ? ' online' : ' away', { dim: true }))
  if (ms !== null) segs.push(seg(`  ${formatMs(ms)}`, { b: isRunning, c: isRunning ? 'warning' : '' }))
  if (c.moveMs !== null && c.moveSide === color) {
    segs.push(seg(`  move ${formatMs(c.moveMs)}`, { c: c.moveMs < 30_000 ? 'error' : 'warning' }))
  }

  return { segs }
}

export const boardOf = (ui: UiState, g: OnlineGame, now: number): OnlineBoard => {
  const st = g.state
  const isOver = st.status === 'finished' || st.status === 'aborted'
  const them: Color = st.you === 'white' ? 'black' : 'white'
  const theirDraw = st.drawOffer !== null && st.drawOffer !== st.you
  const status = isOver
    ? resultText(st)
    : g.pendingMove
      ? 'Sending your move…'
      : `${st.canMove ? 'Your move' : "Opponent's move"}${st.inCheck ? ' · check' : ''}${theirDraw ? ' · draw offered' : ''}`

  return {
    id: st.id,
    moves: st.moves.map(m => m.uci),
    you: side(st.you),
    canMove: st.canMove && !g.pendingMove && !isOver,
    isOver,
    status,
    above: playerRow(g, them, now, false),
    below: playerRow(g, st.you, now, true),
    rev: ui.rev,
  }
}

// The rows under an open game: moves, buttons, chat.
const gameRows = (s: OnlineState, g: OnlineGame, width: number): ViewRow[] => {
  const st = g.state
  const rows: ViewRow[] = []
  const isOver = st.status === 'finished' || st.status === 'aborted'
  const sans = st.moves.map(m => m.san)
  const text = sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san))
  // The last three rows' worth of moves.
  const moveSegs = text.map(t => seg(`${t} `))
  const moveRows = wrap([seg('Moves ', { b: true }), ...(moveSegs.length ? moveSegs : [seg('none yet', { dim: true })])], width, '      ')
  rows.push(...moveRows.slice(-3))
  const opp = opponentOf(st)
  const buttons: ViewSeg[] = []
  if (!isOver) {
    if (st.drawOffer !== null && st.drawOffer !== st.you) {
      buttons.push(seg('Draw offered: ', { c: 'warning' }), btn('accept draw', 'draw:accept'), seg(' '), btn('decline', 'draw:decline'), seg(' '))
    } else if (st.canOfferDraw) {
      buttons.push(btn('offer draw', 'draw:offer'), seg(' '))
    } else if (st.drawOffer === st.you) {
      buttons.push(seg('Draw offered, waiting · ', { dim: true }))
    }
    if (st.canResign) buttons.push(btn('resign', 'resign'), seg(' '))
  }
  buttons.push(btn('lobby', 'back'))
  rows.push(...wrap(buttons, width))
  const thread = st.chatThreadId
  if (thread && opp.username) {
    const seen = new Set<string>()
    const messages = (s.chat[thread] ?? []).filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    rows.push(row(seg(`Chat with ${opp.username} `, { b: true }), btn('write', 'input:chat')))
    for (const m of messages.slice(-4)) {
      const who = m.kind === 'system' ? '' : `${m.sender?.username ?? '?'}: `
      rows.push(...wrap([seg(who, { b: true }), seg(m.text, { dim: m.kind === 'system' })], width, '  ').slice(0, 2))
    }
  }

  return rows
}

const lobbyRows = (ui: UiState, s: OnlineState, width: number): ViewRow[] => {
  const rows: ViewRow[] = []
  const me = s.me
  const others = ui.lobby.filter(e => e.userId !== me?.userId)
  rows.push(row(seg('LOBBY ', { b: true }), seg(`${others.length} waiting `, { dim: true }), btn('refresh', 'refresh')))
  if (me) {
    rows.push(row(seg(`${me.username} · ${me.rating} · ${TIER[tierOf(me.rating)]}`, { dim: true })))
  }
  rows.push(
    s.queue
      ? row(seg('You are in the queue ', { c: 'success' }), btn('leave queue', 'queue:leave'))
      : row(btn('join queue', 'queue:join'), seg(' auto-match with these:', { dim: true })),
  )
  rows.push(
    ...wrap(
      [seg('Clock ', { dim: true }), ...GAME_CLOCKS.flatMap((c, i) => [markSeg(ui.form.gameClocks[i] ?? 'off', gameClockLabel(c), `form:clock:${i}`), seg(' ')])],
      width,
      '      ',
    ),
  )
  rows.push(
    ...wrap(
      [seg('Move  ', { dim: true }), ...PER_MOVE.flatMap((m, i) => [markSeg(ui.form.perMove[i] ?? 'off', perMoveLabel(m).replace('/move', ''), `form:pm:${i}`), seg(' ')])],
      width,
      '      ',
    ),
  )
  rows.push(row(seg('Range ', { dim: true }), btn('−', 'form:range:-1'), seg(` ${rangeLabel(ui.form)} `), btn('+', 'form:range:1'), seg('  · ok  * preferred', { dim: true })))

  if (others.length) {
    rows.push(row(seg('Waiting', { b: true })))
    for (const e of others.slice(0, 8)) {
      rows.push(...wrap([seg(`${e.username} ${e.rating} `), seg(`${wishes(e)} `, { dim: true }), btn('offer', `offer:${e.userId}`)], width, '  '))
    }
  }
  const incoming = incomingOffers(s)
  const outgoing = outgoingOffers(s)
  if (incoming.length || outgoing.length) rows.push(row(seg('Offers', { b: true })))
  for (const o of incoming) {
    rows.push(
      ...wrap(
        [seg(`${o.from.username} ${o.from.rating} `), seg(`${timeControlLabel(o.timeControl)} `, { dim: true }), btn('accept', `accept:${o.id}`), seg(' '), btn('decline', `decline:${o.id}`)],
        width,
        '  ',
      ),
    )
  }
  for (const o of outgoing) {
    rows.push(...wrap([seg(`to ${o.to.username} `), seg(`${timeControlLabel(o.timeControl)} `, { dim: true }), btn('cancel', `decline:${o.id}`)], width, '  '))
  }

  const games = Object.values(s.games).sort((a, b) => (b.state.lastMoveAt ?? b.state.createdAt).localeCompare(a.state.lastMoveAt ?? a.state.createdAt))
  const live = games.filter(g => g.state.status === 'active' || g.state.status === 'waiting')
  const done = games.filter(g => g.state.status === 'finished' || g.state.status === 'aborted').slice(0, 3)
  if (live.length || done.length) rows.push(row(seg('Your games', { b: true })))
  for (const g of [...live, ...done]) {
    const opp = opponentOf(g.state)
    const isLive = g.state.status === 'active' || g.state.status === 'waiting'
    const state = isLive ? (g.state.canMove ? 'your move' : 'their move') : resultText(g.state)
    rows.push(
      ...wrap(
        [seg(`vs ${opp.username ?? (opp.kind === 'engine' ? 'Computer' : 'Guest')} `), seg(`${state} · ${timeControlLabel(g.state.timeControl)} `, { dim: !isLive, c: isLive && g.state.canMove ? 'warning' : '' }), btn(isLive ? 'play' : 'view', `open:${g.state.id}`)],
        width,
        '  ',
      ),
    )
  }

  const f = ui.friends
  const friendSegs: ViewSeg[] = [seg('Friends ', { b: true })]
  for (const one of f?.friends ?? []) friendSegs.push(seg(`${one.online ? '●' : '○'} ${one.username} `, { c: one.online ? 'success' : '', dim: !one.online }))
  if (f && f.friends.length === 0) friendSegs.push(seg('none yet ', { dim: true }))
  friendSegs.push(btn('add', 'input:friend'))
  rows.push(...wrap(friendSegs, width, '  '))
  for (const r of f?.incoming ?? []) {
    rows.push(row(seg(`  ${r.username} ${r.rating} wants to be friends `), btn('accept', `friend:accept:${r.userId}`)))
  }

  return rows
}

export const onlineView = (
  ui: UiState,
  s: OnlineState,
  now: number,
  width: number,
): { rows: ViewRow[]; board: OnlineBoard | null } => {
  const w = Math.max(20, width)
  const open = ui.gameId ? s.games[ui.gameId] : undefined
  const rows = open ? gameRows(s, open, w) : lobbyRows(ui, s, w)
  if (ui.note) rows.push(...wrap([seg(ui.note, { c: 'warning' })], w))

  return { rows, board: open ? boardOf(ui, open, now) : null }
}
