import type { GameClock, QueueJoinRequest, TimeControl } from '../net/protocol'

// The /games pane's lobby form, as data: a rating range around your rating
// (steps of 50, default +-150, or any) and, per dimension (overall game
// clock, per-move limit), a multi-select where each option is off,
// accepted, or preferred. The pane (with the port) draws it; this turns it
// into the queue-join body.

export type Mark = 'off' | 'accepted' | 'preferred'

export const GAME_CLOCKS: readonly (GameClock | null)[] = [
  null,
  { initialMs: 5 * 60_000, incrementMs: 0 },
  { initialMs: 10 * 60_000, incrementMs: 0 },
  { initialMs: 15 * 60_000, incrementMs: 10_000 },
  { initialMs: 30 * 60_000, incrementMs: 0 },
]

export const PER_MOVE: readonly (number | null)[] = [null, 30_000, 60_000, 180_000, 86_400_000]

export const RANGE_STEP = 50
export const RANGE_DEFAULT = 150
// Wide enough for every Elo rating; sent for "any".
const ANY_RANGE = { min: 0, max: 10_000 }

export type QueueForm = {
  // Half width of the rating range, or 'any'.
  range: number | 'any'
  gameClocks: Mark[] // by index into GAME_CLOCKS
  perMove: Mark[] // by index into PER_MOVE
}

// Default: no game clock, 180 s per move (DEFAULT_TIME_CONTROL), both preferred.
export const defaultQueueForm = (): QueueForm => ({
  range: RANGE_DEFAULT,
  gameClocks: GAME_CLOCKS.map(c => (c === null ? 'preferred' : 'off')),
  perMove: PER_MOVE.map(ms => (ms === 180_000 ? 'preferred' : 'off')),
})

const NEXT: Record<Mark, Mark> = { off: 'accepted', accepted: 'preferred', preferred: 'off' }

export const cycleMark = (form: QueueForm, dim: 'gameClocks' | 'perMove', index: number): QueueForm => {
  const marks = [...form[dim]]
  const mark = marks[index]
  if (mark === undefined) return form
  marks[index] = NEXT[mark]

  return { ...form, [dim]: marks }
}

// +1 widens by one step (past 1000 becomes any), -1 narrows (from any back
// to the default), never below one step.
export const stepRange = (form: QueueForm, dir: 1 | -1): QueueForm => {
  if (form.range === 'any') return dir < 0 ? { ...form, range: RANGE_DEFAULT } : form
  const next = form.range + dir * RANGE_STEP
  if (next > 1000) return { ...form, range: 'any' }

  return { ...form, range: Math.max(RANGE_STEP, next) }
}

const pick = <T>(options: readonly T[], marks: readonly Mark[]) => ({
  accepted: options.filter((_, i) => marks[i] === 'accepted' || marks[i] === 'preferred'),
  preferred: options.filter((_, i) => marks[i] === 'preferred'),
})

// The join body, or a reason the form cannot be sent yet.
export const toJoinRequest = (form: QueueForm, rating: number): QueueJoinRequest | { error: string } => {
  const gameClocks = pick(GAME_CLOCKS, form.gameClocks)
  const perMove = pick(PER_MOVE, form.perMove)
  if (!gameClocks.accepted.length) return { error: 'Pick at least one game clock option' }
  if (!perMove.accepted.length) return { error: 'Pick at least one per-move option' }
  // Both "none" alone would be fine (unlimited); nothing else to check.
  const ratingRange =
    form.range === 'any' ? ANY_RANGE : { min: Math.max(0, rating - form.range), max: rating + form.range }

  return { ratingRange, gameClocks, perMove }
}

const mins = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`)

export const gameClockLabel = (c: GameClock | null) =>
  c === null ? 'none' : `${c.initialMs / 60_000}+${c.incrementMs / 1000}`

export const perMoveLabel = (ms: number | null) =>
  ms === null ? 'none' : ms >= 86_400_000 ? `${ms / 86_400_000}d` : mins(ms)

export const timeControlLabel = (tc: TimeControl): string => {
  if (!tc.gameClock && tc.perMoveMs === null) return 'unlimited'
  const parts = []
  if (tc.gameClock) parts.push(gameClockLabel(tc.gameClock))
  if (tc.perMoveMs !== null) parts.push(`${perMoveLabel(tc.perMoveMs)}/move`)

  return parts.join(' + ')
}

// mm:ss (h:mm:ss past an hour) for a clock or a per-move countdown.
export const formatMs = (ms: number): string => {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')

  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
