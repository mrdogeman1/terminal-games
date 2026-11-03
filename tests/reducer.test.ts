import { expect, test } from 'claude-code/testing'

import type { GameEventEnvelope, GameState, MeResponse, MoveInfo, Offer } from '../hooks/net/protocol'
import {
  applyMe,
  applyOffers,
  applySnapshot,
  beginMove,
  clockView,
  emptyOnline,
  failMove,
  incomingOffers,
  outgoingOffers,
  reduceEvent,
  reduceEvents,
  takeFetches,
  tierOf,
} from '../hooks/online/reducer'
import type { OnlineState } from '../hooks/online/reducer'

const FEN0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const FEN1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
const FEN2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'
const T0 = Date.UTC(2026, 10, 3, 14, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

const move = (ply: number, uci: string, fenAfter: string): MoveInfo => ({ ply, san: uci, uci, fenAfter, clockMs: null, at: iso(T0 + ply * 1000) })

const snapshot = (over: Partial<GameState> = {}): GameState => ({
  id: 'g1',
  mode: 'online',
  source: 'web',
  timeControl: { gameClock: { initialMs: 300_000, incrementMs: 0 }, perMoveMs: 60_000 },
  engineLevel: null,
  rated: true,
  status: 'active',
  result: null,
  reason: null,
  white: { kind: 'user', userId: 'me', username: 'luc', rating: 1214, online: true },
  black: { kind: 'user', userId: 'op', username: 'anna_b', rating: 1190, online: true },
  you: 'white',
  turn: 'black',
  fen: FEN1,
  plyCount: 1,
  lastMove: { uci: 'e2e4', san: 'e4' },
  moveDeadlineAt: iso(T0 + 61_000),
  ratingDeltaWhite: null,
  ratingDeltaBlack: null,
  createdAt: iso(T0),
  lastMoveAt: iso(T0 + 1000),
  pgn: '',
  moves: [move(1, 'e2e4', FEN1)],
  clock: { initialMs: 300_000, incrementMs: 0, whiteMs: 300_000, blackMs: 300_000, running: null, serverTime: T0 + 1000 },
  serverTime: T0 + 1000,
  drawOffer: null,
  inCheck: false,
  legalMoves: [],
  canMove: false,
  canResign: true,
  canAbort: true,
  canOfferDraw: true,
  canAcceptDraw: false,
  chatThreadId: 't1',
  eventSeq: 100,
  ...over,
})

const env = <T extends GameEventEnvelope['type']>(seq: number, type: T, payload: GameEventEnvelope<T>['payload']) =>
  ({ seq, type, at: iso(T0), gameId: (payload as { gameId?: string }).gameId ?? null, payload }) as GameEventEnvelope

const ME: MeResponse = {
  user: { id: 'me', username: 'luc', rating: 1214, role: 'USER', createdAt: '' },
  eventSeq: 90,
  activeGameIds: ['g1', 'g2'],
  queue: null,
  serverTime: T0,
}

const LOCAL = 5_000_000 // the local clock (deliberately not the server's)

const withGame = (): OnlineState => applySnapshot(applyMe(emptyOnline(), ME), snapshot(), LOCAL)

const blackMoves = (seq: number, ply = 2, uci = 'e7e5') =>
  env(seq, 'game.move', {
    gameId: 'g1',
    move: move(ply, uci, FEN2),
    by: 'black',
    fen: FEN2,
    plyCount: ply,
    turn: 'white',
    inCheck: false,
    status: 'active',
    drawOffer: null,
    clock: { initialMs: 300_000, incrementMs: 0, whiteMs: 300_000, blackMs: 300_000, running: 'white', serverTime: T0 + 2000 },
    moveDeadlineAt: iso(T0 + 62_000),
  })

test('me asks for its active games; a snapshot fills one in', () => {
  const s0 = applyMe(emptyOnline(), ME)
  expect(s0.me).toEqual({ userId: 'me', username: 'luc', rating: 1214 })
  const [ids, s1] = takeFetches(s0)
  expect(ids).toEqual(['g1', 'g2'])
  expect(s1.toFetch).toEqual([])
  const s2 = applySnapshot(s0, snapshot(), LOCAL)
  expect(s2.toFetch).toEqual(['g2'])
  expect(s2.games.g1?.seenSeq).toBe(100)
})

test('game.move applies the next ply, events at or below the snapshot are ignored', () => {
  const s = withGame()
  expect(reduceEvent(s, blackMoves(100), LOCAL)).toBe(s) // already in the snapshot

  const next = reduceEvent(s, blackMoves(101), LOCAL + 10)
  const g = next.games.g1!
  expect(g.state.plyCount).toBe(2)
  expect(g.state.fen).toBe(FEN2)
  expect(g.state.turn).toBe('white')
  expect(g.state.moves.map(m => m.uci)).toEqual(['e2e4', 'e7e5'])
  expect(g.state.lastMove).toEqual({ uci: 'e7e5', san: 'e7e5' })
  expect(g.state.canMove).toBe(true)
  expect(g.state.canAbort).toBe(false)
  expect(g.seenSeq).toBe(101)
  expect(g.clockAt).toBe(LOCAL + 10)
  expect(next.toFetch).toEqual(['g2'])

  // The same event again changes nothing.
  expect(reduceEvent(next, blackMoves(101), LOCAL + 20)).toBe(next)
})

test('a gap in plies or an unknown game asks for a refetch', () => {
  const s = withGame()
  const gap = reduceEvent(s, blackMoves(101, 3, 'g1f3'), LOCAL)
  expect(gap.games.g1?.state.plyCount).toBe(1)
  expect(gap.toFetch).toContain('g1')

  const unknown = reduceEvent(s, { ...blackMoves(101), payload: { ...blackMoves(101).payload, gameId: 'g9' } } as GameEventEnvelope, LOCAL)
  expect(unknown.toFetch).toContain('g9')

  // A different move at a ply we already have: our mirror is wrong.
  const clash = reduceEvent(s, { ...blackMoves(101, 1, 'd2d4') }, LOCAL)
  expect(clash.toFetch).toContain('g1')
})

test('own move: shown pending, confirmed by the echo, or refetched on failure', () => {
  const s = applySnapshot(applyMe(emptyOnline(), ME), snapshot({ turn: 'white', plyCount: 0, moves: [], fen: FEN0, canMove: true }), LOCAL)
  const pending = beginMove(s, 'g1', 'e2e4')
  expect(pending.games.g1?.pendingMove).toBe('e2e4')

  const echo = env(101, 'game.move', {
    gameId: 'g1', move: move(1, 'e2e4', FEN1), by: 'white', fen: FEN1, plyCount: 1, turn: 'black',
    inCheck: false, status: 'active', drawOffer: null, clock: null, moveDeadlineAt: null,
  })
  const confirmed = reduceEvent(pending, echo, LOCAL)
  expect(confirmed.games.g1?.pendingMove).toBeNull()
  expect(confirmed.games.g1?.state.canMove).toBe(false)

  const failed = failMove(pending, 'g1')
  expect(failed.games.g1?.pendingMove).toBeNull()
  expect(failed.toFetch).toContain('g1')

  // Not our turn: nothing pending.
  expect(beginMove(withGame(), 'g1', 'e7e5')).toEqual(withGame())
})

test('a newer snapshot replaces the mirror, an older one does not', () => {
  const s = reduceEvent(withGame(), blackMoves(101), LOCAL)
  expect(applySnapshot(s, snapshot({ eventSeq: 100 }), LOCAL)).toBe(s)
  const fresh = applySnapshot(s, snapshot({ eventSeq: 140, plyCount: 2, fen: FEN2 }), LOCAL + 5)
  expect(fresh.games.g1?.state.fen).toBe(FEN2)
  expect(fresh.games.g1?.seenSeq).toBe(140)
})

test('draw offers, decline, clock heartbeat, game over with new ratings', () => {
  let s = withGame()
  s = reduceEvent(s, env(101, 'game.draw_offer', { gameId: 'g1', by: 'black' }), LOCAL)
  expect(s.games.g1?.state.drawOffer).toBe('black')
  expect(s.games.g1?.state.canAcceptDraw).toBe(true)
  s = reduceEvent(s, env(102, 'game.draw_declined', { gameId: 'g1', by: 'white' }), LOCAL)
  expect(s.games.g1?.state.drawOffer).toBeNull()
  expect(s.games.g1?.state.canOfferDraw).toBe(true)

  const clock = { initialMs: 300_000, incrementMs: 0, whiteMs: 250_000, blackMs: 280_000, running: 'black' as const, serverTime: 0 }
  s = reduceEvent(s, env(103, 'game.clock', { gameId: 'g1', clock }), LOCAL + 100)
  expect(s.games.g1?.state.clock?.whiteMs).toBe(250_000)

  s = reduceEvent(
    s,
    env(104, 'game.over', {
      gameId: 'g1', status: 'finished', result: '0-1', reason: 'timeout', ratingDeltaWhite: -15,
      ratingDeltaBlack: 15, whiteRating: 1199, blackRating: 1205, clock: { ...clock, blackMs: 0, running: null },
    }),
    LOCAL + 200,
  )
  const g = s.games.g1!.state
  expect(g.status).toBe('finished')
  expect(g.result).toBe('0-1')
  expect(g.reason).toBe('timeout')
  expect(g.canMove || g.canResign || g.canOfferDraw).toBe(false)
  expect(g.white.rating).toBe(1199)
  expect(s.me?.rating).toBe(1199)
  expect(s.games.g1?.moveDeadline).toBeNull()
})

test('lobby and offers: match.found, match.cancelled, offer.received, offer.cancelled', () => {
  const entry = { userId: 'me', username: 'luc', rating: 1214, since: '', ratingRange: { min: 1064, max: 1364 }, gameClocks: { accepted: [null], preferred: [null] }, perMove: { accepted: [180_000], preferred: [180_000] } }
  let s: OnlineState = { ...applyMe(emptyOnline(), { ...ME, activeGameIds: [], queue: entry }) }
  expect(s.queue).toEqual(entry)

  s = reduceEvent(s, env(1, 'match.cancelled', { reason: 'replaced' }), LOCAL)
  expect(s.queue).toEqual(entry)
  s = reduceEvent(s, env(2, 'match.cancelled', { reason: 'stale' }), LOCAL)
  expect(s.queue).toBeNull()
  expect(s.lastQueueCancel).toBe('stale')

  const offer = (id: string, from: string, to: string): Offer => ({
    id, kind: 'queue', from: { userId: from, username: from, rating: 1200 }, to: { userId: to, username: to, rating: 1200 },
    timeControl: { gameClock: null, perMoveMs: 180_000 }, fromColor: 'random', status: 'pending', createdAt: '', expiresAt: '', gameId: null,
  })
  s = reduceEvent(s, env(3, 'offer.received', { offer: offer('o1', 'op', 'me') }), LOCAL)
  s = applyOffers(s, [offer('o1', 'op', 'me')], [offer('o2', 'me', 'x')])
  expect(incomingOffers(s).map(o => o.id)).toEqual(['o1'])
  expect(outgoingOffers(s).map(o => o.id)).toEqual(['o2'])
  s = reduceEvent(s, env(4, 'offer.cancelled', { offerId: 'o1', reason: 'accepted' }), LOCAL)
  expect(Object.keys(s.offers)).toEqual(['o2'])

  const tc = { gameClock: null, perMoveMs: 86_400_000 }
  s = reduceEvent(s, env(5, 'match.found', { gameId: 'g7', color: 'black', opponent: { userId: 'op', username: 'anna_b', rating: 1190 }, timeControl: tc, via: 'offer' }), LOCAL)
  expect(s.lastMatch?.timeControl).toEqual(tc)
  expect(s.toFetch).toEqual(['g7'])
})

test('pair chat: kept per thread, unread counts only the other side\'s typed messages', () => {
  let s = applyMe(emptyOnline(), ME)
  const msg = (id: string, kind: 'user' | 'system', sender: string | null) => ({
    id, threadId: 't1', kind, sender: sender ? { userId: sender, username: sender } : null, text: id,
    system: null, at: '',
  })
  s = reduceEvent(s, env(1, 'chat.message', { threadId: 't1', message: msg('m1', 'system', null) }), LOCAL)
  s = reduceEvent(s, env(2, 'chat.message', { threadId: 't1', message: msg('m2', 'user', 'op') }), LOCAL)
  s = reduceEvent(s, env(3, 'chat.message', { threadId: 't1', message: msg('m3', 'user', 'me') }), LOCAL)
  s = reduceEvent(s, env(3, 'chat.message', { threadId: 't1', message: msg('m3', 'user', 'me') }), LOCAL)
  expect(s.chat.t1?.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
  expect(s.unread.t1).toBe(1)

  s = reduceEvents(s, [env(4, 'friend.request', { from: { userId: 'f', username: 'f', rating: 1 } }), env(5, 'presence.changed', { userId: 'f', username: 'f', online: true, lastSeenAt: '' })], LOCAL)
  expect(s.friendRequests.map(u => u.userId)).toEqual(['f'])
  expect(s.presence.f).toBe(true)
  s = reduceEvent(s, env(6, 'friend.accepted', { user: { userId: 'f', username: 'f', rating: 1 } }), LOCAL)
  expect(s.friendRequests).toEqual([])

  // Unknown event types are ignored.
  expect(reduceEvent(s, { seq: 7, type: 'lobby.weather' }, LOCAL)).toBe(s)
})

test('clocks extrapolate from the local receive time; with a per-move limit both are shown', () => {
  const s = reduceEvent(withGame(), blackMoves(101), LOCAL)
  const g = s.games.g1!
  const now = clockView(g, LOCAL + 7_000)
  expect(now.whiteMs).toBe(293_000)
  expect(now.blackMs).toBe(300_000)
  expect(now.running).toBe('white')
  // Deadline 60 s after the move's server time, counted down locally.
  expect(now.moveMs).toBe(53_000)
  expect(now.moveSide).toBe('white')
  const late = clockView(g, LOCAL + 400_000)
  expect(late.whiteMs).toBe(0)
  expect(late.moveMs).toBe(0)

  const unlimited = applySnapshot(emptyOnline(), snapshot({ clock: null, moveDeadlineAt: null, timeControl: { gameClock: null, perMoveMs: null } }), LOCAL)
  expect(clockView(unlimited.games.g1!, LOCAL + 1000)).toEqual({ whiteMs: null, blackMs: null, running: null, moveMs: null, moveSide: null })
})

test('tier labels', () => {
  expect([999, 1000, 1299, 1300, 1599, 1600].map(tierOf)).toEqual(['beginner', 'casual', 'casual', 'club', 'club', 'expert'])
})
