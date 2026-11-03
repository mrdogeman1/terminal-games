import { MIN_RANGE } from '../net/protocol'
import type { GameClockOption, LobbySettings, PerMoveOption, TimeControl } from '../net/protocol'

// The /games pane's lobby form, as data (PROTOCOL.md 6.1, 9.1): a rating
// range around your rating (steps of 50, at least +-50, default +-150, or
// any) and, per dimension (game clock, per-move limit), a multi-select where
// each option is off, accepted, or preferred. The pane (with the port) draws
// it; this turns it into the lobby-join body.

export type Mark = 'off' | 'accepted' | 'preferred'

// The allowed game clocks (6.1), "none" first.
export const GAME_CLOCKS: readonly GameClockOption[] = [
  null,
  { initialMs: 300_000, incrementMs: 0 },
  { initialMs: 600_000, incrementMs: 0 },
  { initialMs: 900_000, incrementMs: 10_000 },
]

// "none" and the per-move presets (6.1); at most 10 may be accepted.
export const PER_MOVE: readonly PerMoveOption[] = [
  null, 60_000, 180_000, 300_000, 1_800_000, 3_600_000, 86_400_000, 259_200_000,
]

export const RANGE_STEP = MIN_RANGE
export const RANGE_DEFAULT = 150

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
export const toJoinRequest = (form: QueueForm, rating: number): LobbySettings | { error: string } => {
  const gameClocks = pick(GAME_CLOCKS, form.gameClocks)
  const perMove = pick(PER_MOVE, form.perMove)
  if (!gameClocks.accepted.length) return { error: 'Pick at least one game clock option' }
  if (!perMove.accepted.length) return { error: 'Pick at least one per-move option' }
  // Both "none" alone is fine: unlimited.
  const ratingRange =
    form.range === 'any'
      ? { min: null, max: null }
      : { min: rating - Math.max(MIN_RANGE, form.range), max: rating + Math.max(MIN_RANGE, form.range) }

  return { ratingRange, gameClocks, perMove }
}

// Labels of 6.1: "5+0", "3 min/move", "1 day/move", "90 s/move", "Unlimited".
export const gameClockLabel = (c: GameClockOption) =>
  c === null ? 'no clock' : `${c.initialMs / 60_000}+${c.incrementMs / 1000}`

const UNITS: readonly [number, string, string][] = [
  [86_400_000, 'day', 'days'],
  [3_600_000, 'h', 'h'],
  [60_000, 'min', 'min'],
  [1_000, 's', 's'],
]

export const perMoveLabel = (ms: PerMoveOption): string => {
  if (ms === null) return 'no limit'
  const [unit, one, many] = UNITS.find(([u]) => ms % u === 0) ?? [1_000, 's', 's']
  const n = ms / unit

  return `${n} ${n === 1 ? one : many}/move`
}

export const timeControlLabel = (tc: TimeControl): string => {
  if (!tc.gameClock && tc.perMoveMs === null) return 'Unlimited'
  const parts: string[] = []
  if (tc.gameClock) parts.push(gameClockLabel(tc.gameClock))
  if (tc.perMoveMs !== null) parts.push(perMoveLabel(tc.perMoveMs))

  return parts.join(' + ')
}

// A game is live with a game clock or a per-move limit of 1 h or less
// (6.1); one active live game per user (9.6).
export const isLive = (tc: TimeControl): boolean =>
  tc.gameClock !== null || (tc.perMoveMs !== null && tc.perMoveMs <= 3_600_000)

// mm:ss (h:mm:ss past an hour, "Nd hh:mm" past a day) for a clock or a
// per-move countdown.
export const formatMs = (ms: number): string => {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  if (d) return `${d}d ${p2(h)}:${p2(m)}`

  return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`
}
