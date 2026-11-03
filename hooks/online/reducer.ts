import type {
  ChallengePayload,
  ChatMessageInfo,
  ClockState,
  Color,
  GameEventEnvelope,
  GameState,
  MatchCancelReason,
  MatchFoundPayload,
  MeResponse,
  Offer,
  QueueStatus,
  Tier,
  UserRef,
} from '../net/protocol'

// The local mirror of the server's state for online play, built from
// snapshots (GET /api/mod/games/:id, /me) and the event stream (PROTOCOL.md
// 13-14). Pure: every function returns a new state. The server is the
// authority; when the mirror cannot follow (a gap in plies, an unknown
// game), the game id lands in `toFetch` and the controller fetches it.

export type MoveDeadline = {
  // Time left for the side to move when it was received, and the local
  // receive time (`$.clock.now()`): shown as max(0, leftMs - (now - at)).
  leftMs: number
  at: number
}

export type OnlineGame = {
  state: GameState
  // The newest seq this mirror reflects: the snapshot's eventSeq or a later
  // applied event. Events at or below it are already in.
  seenSeq: number
  // Local receive time of `state.clock` (section 6: extrapolate from it).
  clockAt: number
  moveDeadline: MoveDeadline | null
  // A move of ours sent, not yet confirmed (shown at once, 17.4).
  pendingMove: string | null
}

export type OnlineState = {
  me: { userId: string; username: string; rating: number } | null
  games: Record<string, OnlineGame>
  challenges: Record<string, ChallengePayload>
  offers: Record<string, Offer>
  queue: QueueStatus | null
  lastMatch: MatchFoundPayload | null
  lastQueueCancel: MatchCancelReason | null
  toFetch: string[]
  friendRequests: UserRef[]
  presence: Record<string, boolean>
  chat: Record<string, ChatMessageInfo[]>
  unread: Record<string, number>
}

const CHAT_KEEP = 50

export const emptyOnline = (): OnlineState => ({
  me: null,
  games: {},
  challenges: {},
  offers: {},
  queue: null,
  lastMatch: null,
  lastQueueCancel: null,
  toFetch: [],
  friendRequests: [],
  presence: {},
  chat: {},
  unread: {},
})

// Rating tier label (PROTOCOL.md 5; labels only in the open lobby).
export const tierOf = (rating: number): Exclude<Tier, 'any'> =>
  rating < 1000 ? 'beginner' : rating < 1300 ? 'casual' : rating < 1600 ? 'club' : 'expert'

const fetchLater = (s: OnlineState, gameId: string): OnlineState =>
  s.toFetch.includes(gameId) ? s : { ...s, toFetch: [...s.toFetch, gameId] }

const deadlineOf = (deadlineAt: string | null | undefined, serverTime: number | null, now: number): MoveDeadline | null => {
  if (!deadlineAt) return null
  const at = Date.parse(deadlineAt)
  if (Number.isNaN(at)) return null

  // Measured against the server's time when it gave one, so a skewed local
  // clock does not shift the countdown; else against the local clock.
  return { leftMs: Math.max(0, at - (serverTime ?? now)), at: now }
}

// What the server would say the player may do, after the mirror changed.
const withAbilities = (g: GameState): GameState => {
  const isActive = g.status === 'active'
  const isOnline = g.mode === 'online'
  const isMine = g.mode === 'computer' || g.turn === g.you

  return {
    ...g,
    canMove: isActive && isMine,
    // Legal moves come from the local rules (chess.ts, with the port).
    legalMoves: [],
    canResign: isActive,
    canAbort: isActive && isOnline && g.plyCount < 2,
    canOfferDraw: isActive && isOnline && g.drawOffer !== g.you,
    canAcceptDraw: isActive && isOnline && g.drawOffer !== null && g.drawOffer !== g.you,
    canAcceptChallenge: false,
  }
}

// /me after login, a restart or a 410: queue entry and active games.
export const applyMe = (s: OnlineState, me: MeResponse): OnlineState => {
  let next: OnlineState = {
    ...s,
    me: { userId: me.user.id, username: me.user.username, rating: me.user.rating },
    queue: me.queue,
  }
  for (const id of me.activeGameIds) next = fetchLater(next, id)

  return next
}

// A full GameState from the server. Taken unless the mirror has already
// seen newer events for that game.
export const applySnapshot = (s: OnlineState, game: GameState, now: number): OnlineState => {
  const local = s.games[game.id]
  if (local && game.eventSeq < local.seenSeq) return s
  const serverTime = game.clock?.serverTime ?? null
  const games = {
    ...s.games,
    [game.id]: {
      state: game,
      seenSeq: game.eventSeq,
      clockAt: now,
      moveDeadline: deadlineOf(game.moveDeadlineAt, serverTime, now),
      pendingMove: null,
    },
  }
  const challenges = { ...s.challenges }
  if (game.status !== 'waiting') delete challenges[game.id]

  return { ...s, games, challenges, toFetch: s.toFetch.filter(id => id !== game.id) }
}

// Our own move, shown at once; the POST's answer (applySnapshot) or the
// game.move event confirms it, a 400/409 is followed by a refetch.
export const beginMove = (s: OnlineState, gameId: string, uci: string): OnlineState => {
  const local = s.games[gameId]
  if (!local || !local.state.canMove) return s

  return { ...s, games: { ...s.games, [gameId]: { ...local, pendingMove: uci } } }
}

export const failMove = (s: OnlineState, gameId: string): OnlineState => {
  const local = s.games[gameId]
  if (!local) return s

  return fetchLater({ ...s, games: { ...s.games, [gameId]: { ...local, pendingMove: null } } }, gameId)
}

// The ids to fetch now, and the state without them.
export const takeFetches = (s: OnlineState): [string[], OnlineState] => [s.toFetch, { ...s, toFetch: [] }]

const putGame = (s: OnlineState, id: string, game: OnlineGame): OnlineState => ({
  ...s,
  games: { ...s.games, [id]: game },
})

const otherColor = (c: Color): Color => (c === 'white' ? 'black' : 'white')

// One event. Unknown types are ignored (PROTOCOL.md 1).
export function reduceEvent(s: OnlineState, ev: GameEventEnvelope | { type: string; seq: number }, now: number): OnlineState {
  const e = ev as GameEventEnvelope
  switch (e.type) {
    case 'game.move': {
      const p = (e as GameEventEnvelope<'game.move'>).payload
      const local = s.games[p.gameId]
      if (!local) return fetchLater(s, p.gameId)
      if (e.seq <= local.seenSeq) return s
      const g = local.state
      if (p.move.ply <= g.plyCount) {
        // Already here (our own move's echo): fine if it is the same move.
        return g.moves[p.move.ply - 1]?.uci === p.move.uci ? s : fetchLater(s, p.gameId)
      }
      if (p.move.ply !== g.plyCount + 1) return fetchLater(s, p.gameId)
      const state = withAbilities({
        ...g,
        fen: p.fen,
        plyCount: p.plyCount,
        turn: p.turn,
        inCheck: p.inCheck,
        status: p.status,
        drawOffer: p.drawOffer,
        clock: p.clock ?? g.clock,
        moves: [...g.moves, p.move],
        lastMove: { uci: p.move.uci, san: p.move.san },
        lastMoveAt: p.move.at,
        moveDeadlineAt: p.moveDeadlineAt !== undefined ? p.moveDeadlineAt : g.moveDeadlineAt,
      })

      return putGame(s, p.gameId, {
        state,
        seenSeq: e.seq,
        clockAt: p.clock ? now : local.clockAt,
        moveDeadline:
          p.moveDeadlineAt !== undefined
            ? deadlineOf(p.moveDeadlineAt, p.clock?.serverTime ?? null, now)
            : local.moveDeadline,
        pendingMove: local.pendingMove === p.move.uci ? null : local.pendingMove,
      })
    }
    case 'game.over': {
      const p = (e as GameEventEnvelope<'game.over'>).payload
      const challenges = { ...s.challenges }
      delete challenges[p.gameId]
      const local = s.games[p.gameId]
      if (!local) return fetchLater({ ...s, challenges }, p.gameId)
      if (e.seq <= local.seenSeq) return { ...s, challenges }
      const g = local.state
      const state: GameState = {
        ...g,
        status: p.status,
        result: p.result,
        reason: p.reason,
        ratingDeltaWhite: p.ratingDeltaWhite,
        ratingDeltaBlack: p.ratingDeltaBlack,
        white: p.whiteRating !== null ? { ...g.white, rating: p.whiteRating } : g.white,
        black: p.blackRating !== null ? { ...g.black, rating: p.blackRating } : g.black,
        clock: p.clock ?? (g.clock ? { ...g.clock, running: null } : null),
        drawOffer: null,
        moveDeadlineAt: null,
        legalMoves: [],
        canMove: false,
        canResign: false,
        canAbort: false,
        canOfferDraw: false,
        canAcceptDraw: false,
        canAcceptChallenge: false,
      }
      const newRating = g.you === 'white' ? p.whiteRating : p.blackRating
      const me = s.me && newRating !== null ? { ...s.me, rating: newRating } : s.me

      return putGame({ ...s, challenges, me }, p.gameId, {
        ...local,
        state,
        seenSeq: e.seq,
        clockAt: p.clock ? now : local.clockAt,
        moveDeadline: null,
        pendingMove: null,
      })
    }
    case 'game.draw_offer':
    case 'game.draw_declined': {
      const p = (e as GameEventEnvelope<'game.draw_offer'>).payload
      const local = s.games[p.gameId]
      if (!local) return fetchLater(s, p.gameId)
      if (e.seq <= local.seenSeq) return s
      const drawOffer = e.type === 'game.draw_offer' ? p.by : null

      return putGame(s, p.gameId, {
        ...local,
        seenSeq: e.seq,
        state: withAbilities({ ...local.state, drawOffer }),
      })
    }
    case 'game.clock': {
      const p = (e as GameEventEnvelope<'game.clock'>).payload
      const local = s.games[p.gameId]
      if (!local || e.seq <= local.seenSeq) return s

      return putGame(s, p.gameId, { ...local, seenSeq: e.seq, clockAt: now, state: { ...local.state, clock: p.clock } })
    }
    case 'match.found': {
      const p = (e as GameEventEnvelope<'match.found'>).payload
      const challenges = { ...s.challenges }
      delete challenges[p.gameId]

      return fetchLater({ ...s, queue: null, lastMatch: p, challenges }, p.gameId)
    }
    case 'match.cancelled': {
      const p = (e as GameEventEnvelope<'match.cancelled'>).payload

      return { ...s, queue: p.reason === 'replaced' ? s.queue : null, lastQueueCancel: p.reason }
    }
    case 'challenge.received': {
      const p = (e as GameEventEnvelope<'challenge.received'>).payload

      return { ...s, challenges: { ...s.challenges, [p.gameId]: p } }
    }
    case 'offer.received': {
      const p = (e as GameEventEnvelope<'offer.received'>).payload

      return { ...s, offers: { ...s.offers, [p.offer.id]: p.offer } }
    }
    case 'offer.cancelled': {
      const p = (e as GameEventEnvelope<'offer.cancelled'>).payload
      const offers = { ...s.offers }
      delete offers[p.offerId]

      return { ...s, offers }
    }
    case 'friend.request': {
      const p = (e as GameEventEnvelope<'friend.request'>).payload
      const rest = s.friendRequests.filter(u => u.userId !== p.from.userId)

      return { ...s, friendRequests: [...rest, p.from] }
    }
    case 'friend.accepted': {
      const p = (e as GameEventEnvelope<'friend.accepted'>).payload

      return { ...s, friendRequests: s.friendRequests.filter(u => u.userId !== p.user.userId) }
    }
    case 'friend.removed': {
      const p = (e as GameEventEnvelope<'friend.removed'>).payload

      return { ...s, friendRequests: s.friendRequests.filter(u => u.userId !== p.userId) }
    }
    case 'chat.message': {
      const p = (e as GameEventEnvelope<'chat.message'>).payload
      const kept = s.chat[p.threadId] ?? []
      if (kept.some(m => m.id === p.message.id)) return s
      const isMine = s.me !== null && p.message.sender.userId === s.me.userId

      return {
        ...s,
        chat: { ...s.chat, [p.threadId]: [...kept, p.message].slice(-CHAT_KEEP) },
        unread: isMine ? s.unread : { ...s.unread, [p.threadId]: (s.unread[p.threadId] ?? 0) + 1 },
      }
    }
    case 'presence.changed': {
      const p = (e as GameEventEnvelope<'presence.changed'>).payload

      return { ...s, presence: { ...s.presence, [p.userId]: p.online } }
    }
    default:
      return s
  }
}

export const reduceEvents = (s: OnlineState, events: readonly GameEventEnvelope[], now: number): OnlineState =>
  events.reduce((acc, ev) => reduceEvent(acc, ev, now), s)

export const markRead = (s: OnlineState, threadId: string): OnlineState => {
  const unread = { ...s.unread }
  delete unread[threadId]

  return { ...s, unread }
}

export type ClockView = {
  // Overall game clock, null when the game has none.
  whiteMs: number | null
  blackMs: number | null
  running: Color | null
  // Per-move countdown for the side to move, null when the game has none.
  moveMs: number | null
  moveSide: Color | null
}

// What the pane shows now (section 6: extrapolate from the receive time,
// never from serverTime; at 0 show 0 and wait for the server's game.over).
// Both parts may be set: then the pane shows both.
export const clockView = (g: OnlineGame, now: number): ClockView => {
  const c: ClockState | null = g.state.clock
  const isActive = g.state.status === 'active'
  const spent = Math.max(0, now - g.clockAt)
  const run = (side: Color, ms: number) => (isActive && c?.running === side ? Math.max(0, ms - spent) : ms)
  const moveMs =
    isActive && g.moveDeadline ? Math.max(0, g.moveDeadline.leftMs - Math.max(0, now - g.moveDeadline.at)) : null

  return {
    whiteMs: c ? run('white', c.whiteMs) : null,
    blackMs: c ? run('black', c.blackMs) : null,
    running: isActive ? (c?.running ?? null) : null,
    moveMs,
    moveSide: moveMs === null ? null : g.state.turn,
  }
}

export const opponentOf = (g: GameState) => (g.you === 'white' ? g.black : g.white)
export const sideToMoveIsOpponent = (g: GameState) => g.turn === otherColor(g.you)
