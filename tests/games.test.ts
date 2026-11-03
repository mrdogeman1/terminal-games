import { expect, test } from 'claude-code/testing'

import { GAMES, pick, rand } from '../hooks/games/games'

const byName = (name: string) => GAMES.find(g => g.name === name)!
const dodge = byName('Dodge')

test('pick covers every value about evenly', async () => {
  const counts = new Array(19).fill(0)
  let seed = 12345
  for (let i = 0; i < 19000; i++) {
    seed = rand(seed)
    counts[pick(seed, 19)]++
  }
  expect(Math.min(...counts)).toBeGreaterThan(800)
  expect(Math.max(...counts)).toBeLessThan(1200)
})

test('Dodge drops rocks in every column', async () => {
  for (const seed of [1, 7, 99, 123456, 4000000000]) {
    let g = dodge.init(19, 10, seed)
    const columns = new Set<number>()
    for (let i = 0; i < 600; i++) {
      g = dodge.tick(g)
      for (const [x, y] of g.rocks) if (y === 0) columns.add(x)
    }
    expect(columns.size).toBe(19)
  }
})

test('Dodge has no safe spot: standing still anywhere gets you hit', async () => {
  for (let x = 0; x < 19; x++) {
    for (const seed of [3, 42, 777]) {
      let g = { ...dodge.init(19, 10, seed), x }
      for (let i = 0; i < 1000 && !dodge.isOver(g); i++) g = dodge.tick(g)
      expect([x, seed, dodge.isOver(g)]).toEqual([x, seed, true])
    }
  }
})

test('Dodge speeds up as you go, down to a floor', async () => {
  const at = (dodged: number) =>
    dodge.delay!({ ...dodge.init(19, 10, 1), dodged })
  expect(at(0)).toBe(260)
  expect(at(10)).toBe(250)
  expect(at(30)).toBe(230)
  expect(at(100)).toBe(160)
  expect(at(130)).toBe(130)
  expect(at(500)).toBe(130)
  expect(dodge.status({ ...dodge.init(19, 10, 1), dodged: 30 })).toBe(
    'Dodged 30 · speed 1.1×',
  )
})

test('Dodge starts sparse: about one rock per four ticks', async () => {
  let g = dodge.init(19, 10, 5)
  let made = 0
  for (let i = 0; i < 200; i++) {
    g = { ...dodge.tick({ ...g, dodged: 0 }), dodged: 0 }
    made += g.rocks.filter(([, y]: [number, number]) => y === 0).length
  }
  expect(made).toBeGreaterThan(30)
  expect(made).toBeLessThan(70)
})

test('different seeds give different games', async () => {
  const run = (seed: number) => {
    let g = dodge.init(19, 10, seed)
    for (let i = 0; i < 30; i++) g = dodge.tick(g)
    return JSON.stringify(g.rocks)
  }
  expect(run(1)).not.toBe(run(2))
})

test('game speeds: Snake 300, Pong 320, Bricks 330 ms', async () => {
  expect(byName('Snake').speed).toBe(300)
  expect(byName('Pong').speed).toBe(320)
  expect(byName('Bricks').speed).toBe(330)
})

const pong = byName('Pong')
type P = ReturnType<typeof pong.init>

// A rally that has just started: no wait, ball one cell in front of you.
const rally = (patch: Partial<P> = {}): P => ({
  ...pong.init(19, 10, 1),
  wait: 0,
  scorer: null,
  ...patch,
})

const flashCells = (g: P) => {
  let n = 0
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const kind = pong.kindAt(g, x, y)
      if (kind === 'flashGood' || kind === 'flashBad') n++
    }
  }
  return n
}

test('Pong waits about a second before the first serve', async () => {
  let g = pong.init(19, 10, 1)
  expect(pong.status(g)).toBe('Get ready 0 : 0 · serve in 1')
  const start = [g.bx, g.by]
  for (let i = 0; i < 3; i++) g = pong.tick(g)
  expect([g.bx, g.by]).toEqual(start)
  g = pong.tick(g)
  expect([g.bx, g.by]).not.toEqual(start)
})

test('a CPU point flashes red and holds the serve about 2 seconds', async () => {
  // Ball heading past your paddle, which sits at the bottom.
  let g = pong.tick(rally({ bx: 1, by: 0, dx: -1, dy: 1, you: 7 }))
  expect(g.cpuScore).toBe(1)
  expect(pong.status(g)).toBe('CPU scores! 0 : 1 · serve in 2')
  expect(flashCells(g)).toBeGreaterThan(100)
  expect(pong.kindAt(g, 5, 0)).toBe('flashBad')

  const served = [g.bx, g.by]
  const flashes: number[] = []
  for (let i = 0; i < 6; i++) {
    expect([g.bx, g.by]).toEqual(served)
    flashes.push(flashCells(g) > 0 ? 1 : 0)
    g = pong.tick(g)
  }
  // On, off, on, then a calm countdown.
  expect(flashes).toEqual([1, 0, 1, 0, 0, 0])
  expect(g.wait).toBe(0)
  expect(pong.status(g)).toBe('You 0 : 1 CPU')
  g = pong.tick(g)
  expect([g.bx, g.by]).not.toEqual(served)
})

test('your point flashes green', async () => {
  // Ball about to pass the computer's paddle at the bottom; t + 1 is a tick
  // it stands still.
  const g = pong.tick(rally({ bx: 17, by: 0, dx: 1, dy: 1, cpu: 7, t: 2 }))
  expect(g.youScore).toBe(1)
  expect(pong.status(g)).toBe('You score! 1 : 0 · serve in 2')
  expect(pong.kindAt(g, 5, 0)).toBe('flashGood')
})

test('the winning point ends the game at once, without a pause', async () => {
  const lost = pong.tick(rally({ bx: 1, by: 0, dx: -1, dy: 1, you: 7, cpuScore: 11 }))
  expect(pong.isOver(lost)).toBe(true)
  expect(lost.wait).toBe(0)
  expect(flashCells(lost)).toBe(0)
  expect(pong.status(lost)).toBe('CPU wins 0 : 12')

  const won = pong.tick(rally({ bx: 17, by: 0, dx: 1, dy: 1, cpu: 7, t: 2, youScore: 11 }))
  expect(pong.status(won)).toBe('You win 12 : 0')
})

test('you can move your paddle during the pause', async () => {
  const g = pong.tick(rally({ bx: 1, by: 0, dx: -1, dy: 1, you: 7 }))
  expect(pong.key(g, 'up').you).toBe(6)
})

test('Snake: two quick turns both happen, one a tick (a U-turn)', async () => {
  const snake = byName('Snake')
  // Head at (6, 6), going right.
  let g = snake.init(20, 12, 1)
  expect(g.snake[0]).toEqual([6, 6])

  // Up then left before the next tick: up first, then left.
  g = snake.key(snake.key(g, 'up'), 'left')
  g = snake.tick(g)
  expect(g.snake[0]).toEqual([6, 5])
  g = snake.tick(g)
  expect(g.snake[0]).toEqual([5, 5])
  expect(g.isOver).toBe(false)
  // Then straight on.
  g = snake.tick(g)
  expect(g.snake[0]).toEqual([4, 5])

  // A turn back on the one queued before it is dropped, as is the same way twice.
  g = snake.key(snake.key(snake.key(g, 'down'), 'up'), 'down')
  g = snake.tick(g)
  expect(g.snake[0]).toEqual([4, 6])
  g = snake.tick(g)
  expect(g.snake[0]).toEqual([4, 7])
  // Straight back into itself is still refused.
  g = snake.tick(snake.key(g, 'up'))
  expect(g.snake[0]).toEqual([4, 8])
})

test('Snake: a bite scores the speed it was made at', async () => {
  const snake = byName('Snake')
  // Head at (6, 6) going right; food put right in front of it each time.
  const fed = (g: any) => ({ ...g, food: [g.snake[0][0] + 1, g.snake[0][1]] })
  let g = snake.init(20, 12, 1)
  g = snake.tick(fed(g), 1.3)
  expect(snake.status(g)).toBe('Score 1.3')
  g = snake.tick(fed(g), 1)
  g = snake.tick(fed(g), 2.5)
  expect(snake.score(g)).toBe(4.8)
  expect(snake.status(g)).toBe('Score 4.8')
  // A move without a bite scores nothing.
  g = snake.tick({ ...g, food: [0, 0] }, 5)
  expect(snake.status(g)).toBe('Score 4.8')
})

test('a game has progress once something happened worth keeping', async () => {
  const snake = byName('Snake')
  const fresh = snake.init(20, 12, 1)
  expect(snake.hasProgress!(snake.tick(fresh))).toBe(false)
  expect(snake.hasProgress!({ ...fresh, score: 10 })).toBe(true)
  expect(pong.hasProgress!(pong.init(19, 10, 1))).toBe(false)
  expect(pong.hasProgress!({ ...pong.init(19, 10, 1), cpuScore: 1 })).toBe(true)
  const bricks = byName('Bricks')
  expect(bricks.hasProgress!(bricks.init(19, 10, 1))).toBe(false)
  expect(bricks.hasProgress!({ ...bricks.init(19, 10, 1), lives: 2 })).toBe(true)
  expect(dodge.hasProgress!(dodge.init(19, 10, 1))).toBe(false)
  expect(dodge.hasProgress!({ ...dodge.init(19, 10, 1), dodged: 1 })).toBe(true)
})
