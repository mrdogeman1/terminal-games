import { expect, test } from 'claude-code/testing'

import {
  cycleMark,
  defaultQueueForm,
  formatMs,
  GAME_CLOCKS,
  isLive,
  PER_MOVE,
  perMoveLabel,
  stepRange,
  timeControlLabel,
  toJoinRequest,
} from '../hooks/online/queue-form'

test('default form is the protocol default: +-150, no game clock, 3 min/move, both preferred', () => {
  expect(toJoinRequest(defaultQueueForm(), 1214)).toEqual({
    ratingRange: { min: 1064, max: 1364 },
    gameClocks: { accepted: [null], preferred: [null] },
    perMove: { accepted: [180_000], preferred: [180_000] },
  })
})

test('marks cycle off -> accepted -> preferred -> off; range steps by 50, at least 50, or any', () => {
  let f = defaultQueueForm()
  const fivePlus0 = GAME_CLOCKS.findIndex(c => c?.initialMs === 300_000)
  f = cycleMark(f, 'gameClocks', fivePlus0)
  f = cycleMark(f, 'perMove', PER_MOVE.indexOf(86_400_000))
  f = cycleMark(f, 'perMove', PER_MOVE.indexOf(86_400_000))
  f = stepRange(stepRange(stepRange(stepRange(f, -1), -1), -1), -1)
  expect(f.range).toBe(50)
  expect(toJoinRequest(f, 1200)).toEqual({
    ratingRange: { min: 1150, max: 1250 },
    gameClocks: { accepted: [null, { initialMs: 300_000, incrementMs: 0 }], preferred: [null] },
    perMove: { accepted: [180_000, 86_400_000], preferred: [180_000, 86_400_000] },
  })

  let wide = defaultQueueForm()
  for (let i = 0; i < 20; i++) wide = stepRange(wide, 1)
  expect(wide.range).toBe('any')
  expect(toJoinRequest(wide, 1200)).toMatchObject({ ratingRange: { min: null, max: null } })
  expect(stepRange(wide, -1).range).toBe(150)

  // Turning off the only accepted option is not sendable.
  const none = cycleMark(defaultQueueForm(), 'perMove', PER_MOVE.indexOf(180_000))
  expect(none.perMove[PER_MOVE.indexOf(180_000)]).toBe('off')
  expect(toJoinRequest(none, 1200)).toEqual({ error: 'Pick at least one per-move option' })
})

test('labels and live/correspondence per the protocol', () => {
  expect(timeControlLabel({ gameClock: null, perMoveMs: null })).toBe('Unlimited')
  expect(timeControlLabel({ gameClock: { initialMs: 300_000, incrementMs: 0 }, perMoveMs: 60_000 })).toBe('5+0 + 1 min/move')
  expect(timeControlLabel({ gameClock: { initialMs: 900_000, incrementMs: 10_000 }, perMoveMs: null })).toBe('15+10')
  expect(perMoveLabel(90_000)).toBe('90 s/move')
  expect(perMoveLabel(172_800_000)).toBe('2 days/move')
  expect(perMoveLabel(3_600_000)).toBe('1 h/move')
  expect(isLive({ gameClock: null, perMoveMs: 3_600_000 })).toBe(true)
  expect(isLive({ gameClock: null, perMoveMs: 86_400_000 })).toBe(false)
  expect(isLive({ gameClock: { initialMs: 600_000, incrementMs: 0 }, perMoveMs: null })).toBe(true)
  expect(formatMs(65_000)).toBe('1:05')
  expect(formatMs(3_725_000)).toBe('1:02:05')
  expect(formatMs(90_061_000)).toBe('1d 01:01')
  expect(formatMs(-5)).toBe('0:00')
})
