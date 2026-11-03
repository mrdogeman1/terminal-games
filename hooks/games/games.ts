// The panel's mini games. Each is plain data plus pure functions: the view
// keeps one state per game and calls `tick` on its timer, `key` on a key.
// A board is `w` by `h` cells; each cell draws two columns wide.

import { chess } from './chess'
import { pick, rand } from './random'

export type Dir = 'up' | 'down' | 'left' | 'right'
export type Cell = [number, number]

// What a cell shows; the view maps each kind to characters and a colour.
export type Kind =
  | 'empty'
  | 'head'
  | 'body'
  | 'food'
  | 'you'
  | 'cpu'
  | 'ball'
  | 'brick'
  | 'rock'
  | 'flashGood'
  | 'flashBad'

export type GameDef<G> = {
  name: string
  // Milliseconds between two ticks; `delay`, when given, sets it from the
  // game's state instead (a game that speeds up).
  speed: number
  delay?: (g: G) => number
  // Shown before the first start: how to play.
  help: string
  init: (w: number, h: number, seed: number) => G
  // `knob`: the speed the player set (1 = normal), which a game may score by;
  // for a game with `levels`, the level instead.
  tick: (g: G, knob?: number) => G
  key: (g: G, dir: Dir) => G
  kindAt: (g: G, x: number, y: number) => Kind
  score: (g: G) => number
  // How a score (the game's or the best) is written; absent: as is.
  showScore?: (score: number) => string
  isOver: (g: G) => boolean
  // The status line while the game runs (score and the like).
  status: (g: G) => string
  // A board game: its fixed size in cells, a click on cell (x, y), Enter,
  // and its own look per cell in place of `kindAt`'s.
  size?: Cell
  click?: (g: G, x: number, y: number) => G
  press?: (g: G) => G
  lookAt?: (g: G, x: number, y: number) => Look
  // Any other key the game uses (chess: G for letters).
  other?: (g: G, key: string) => G
  // What a new game keeps from the one before it (a setting).
  carry?: (old: G, fresh: G) => G
  // False where a best score means nothing (chess).
  hasBest?: boolean
  // A game with levels (chess: the computer's strength), named weakest
  // first; a level is 1 to their count. Such a game gets the level row.
  levels?: readonly string[]
  defaultLevel?: number
  // A game an outside engine plays: the position to send it while the
  // engine should move (null otherwise), and its answer played. An answer
  // that isn't a legal move leaves g as it is; `tick` is the fallback.
  ask?: (g: G, level: number) => string | null
  answer?: (g: G, move: string) => G
  // A row drawn under the board (chess: the pieces taken), one Look per
  // piece of text; `t` may be a single column wide. A game with `tray`
  // always gets the row, empty or not.
  tray?: (g: G) => Look[]
  // Whether the game has got anywhere yet (absent: always): a game that
  // just started isn't kept when a new one replaces it.
  hasProgress?: (g: G) => boolean
}

// How one cell draws: two columns of text, its colours, bold or dim.
export type Look = { t: string; c: string; bg: string; dim: boolean; b: boolean }

export { pick, rand } from './random'

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n))

const STEP: Record<Dir, Cell> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
}
const OPPOSITE: Record<Dir, Dir> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
}

// --- Snake: eat the diamonds, don't hit the wall or yourself.

type Snake = {
  w: number
  h: number
  snake: Cell[]
  dir: Dir
  // Turns pressed but not made yet, one a tick, oldest first: two quick
  // presses (up, left) make a U-turn over two ticks.
  turns: Dir[]
  food: Cell
  // In tenths of a point: a bite scores the speed it was made at (1.3x: 1.3).
  score: number
  isOver: boolean
  seed: number
}

const MAX_TURNS = 3

const placeFood = (g: Snake): Snake => {
  let seed = g.seed
  const taken = new Set(g.snake.map(([x, y]) => `${x},${y}`))
  for (let i = 0; i < 200; i++) {
    seed = rand(seed)
    const x = pick(seed, g.w)
    seed = rand(seed)
    const y = pick(seed, g.h)
    if (!taken.has(`${x},${y}`)) return { ...g, food: [x, y], seed }
  }

  return { ...g, seed }
}

const snake: GameDef<Snake> = {
  name: 'Snake',
  speed: 300,
  help: 'eat ◆, avoid walls',
  init: (w, h, seed) => {
    const y = Math.floor(h / 2)
    const x = Math.floor(w / 3)

    return placeFood({
      w,
      h,
      snake: [
        [x, y],
        [x - 1, y],
        [x - 2, y],
      ],
      dir: 'right',
      turns: [],
      food: [0, 0],
      score: 0,
      isOver: false,
      seed: seed || 1,
    })
  },
  tick: (g, speed = 1) => {
    const [dir = g.dir, ...turns] = g.turns ?? []
    const [dx, dy] = STEP[dir]
    const head = g.snake[0]!
    const to: Cell = [head[0] + dx, head[1] + dy]
    const isEating = to[0] === g.food[0] && to[1] === g.food[1]
    const body = isEating ? g.snake : g.snake.slice(0, -1)
    const isHit =
      to[0] < 0 ||
      to[1] < 0 ||
      to[0] >= g.w ||
      to[1] >= g.h ||
      body.some(([x, y]) => x === to[0] && y === to[1])
    if (isHit) return { ...g, dir, turns, isOver: true }
    const moved = { ...g, dir, turns, snake: [to, ...body] }

    const bite = Math.max(1, Math.round(speed * 10))

    return isEating ? placeFood({ ...moved, score: g.score + bite }) : moved
  },
  // A turn counts from the last one queued: not back on itself, not the
  // same way again. At most three wait.
  key: (g, dir) => {
    const turns = g.turns ?? []
    const last = turns[turns.length - 1] ?? g.dir
    if (dir === last || dir === OPPOSITE[last] || turns.length >= MAX_TURNS) return g

    return { ...g, turns: [...turns, dir] }
  },
  kindAt: (g, x, y) => {
    const at = g.snake.findIndex(([sx, sy]) => sx === x && sy === y)
    if (at === 0) return 'head'
    if (at > 0) return 'body'

    return g.food[0] === x && g.food[1] === y ? 'food' : 'empty'
  },
  score: g => g.score / 10,
  showScore: n => n.toFixed(1),
  isOver: g => g.isOver,
  status: g => `Score ${(g.score / 10).toFixed(1)}`,
  // Worth keeping once a bite is eaten.
  hasProgress: g => g.score > 0,
}

// --- Pong: a paddle duel against the computer, first to 12.

type Pong = {
  w: number
  h: number
  you: number
  cpu: number
  bx: number
  by: number
  dx: number
  dy: number
  youScore: number
  cpuScore: number
  t: number
  seed: number
  // Ticks left before the ball is served; while it counts down the ball
  // waits in the middle.
  wait: number
  // Who scored the point being shown; the board flashes for them.
  scorer: 'you' | 'cpu' | null
}

const PADDLE = 3
const PONG_WIN = 12
const PONG_MS = 320
// About 2 seconds between a point and the next serve.
const SERVE_WAIT = 6
// Before the first serve, about 1 second.
const START_WAIT = 3

// The board flashes on the first and third tick of the wait.
const isFlashing = (g: Pong) =>
  g.scorer !== null &&
  (g.wait === SERVE_WAIT || g.wait === SERVE_WAIT - 2)

const secondsLeft = (g: Pong) => Math.max(1, Math.ceil((g.wait * PONG_MS) / 1000))

// A point: serve toward whoever lost it, after a pause, unless it won the game.
const point = (g: Pong, scorer: 'you' | 'cpu'): Pong => {
  const scored = {
    ...g,
    youScore: g.youScore + (scorer === 'you' ? 1 : 0),
    cpuScore: g.cpuScore + (scorer === 'cpu' ? 1 : 0),
  }
  const isWon = scored.youScore >= PONG_WIN || scored.cpuScore >= PONG_WIN

  return {
    ...serve(scored, scorer === 'you' ? 1 : -1),
    wait: isWon ? 0 : SERVE_WAIT,
    scorer: isWon ? null : scorer,
  }
}

const serve = (g: Pong, toward: number): Pong => {
  const seed = rand(g.seed)

  return {
    ...g,
    bx: Math.floor(g.w / 2),
    by: Math.floor(g.h / 2),
    dx: toward,
    dy: pick(seed, 2) === 0 ? 1 : -1,
    seed,
  }
}

// Where a paddle sends the ball: up off its top, down off its bottom.
const deflect = (top: number, y: number, dy: number) =>
  y === top ? -1 : y === top + PADDLE - 1 ? 1 : dy

const pong: GameDef<Pong> = {
  name: 'Pong',
  speed: PONG_MS,
  help: 'up/down moves you, first to 12',
  init: (w, h, seed) =>
    serve(
      {
        w,
        h,
        you: Math.floor((h - PADDLE) / 2),
        cpu: Math.floor((h - PADDLE) / 2),
        bx: 0,
        by: 0,
        dx: -1,
        dy: 1,
        youScore: 0,
        cpuScore: 0,
        t: 0,
        seed: seed || 1,
        wait: START_WAIT,
        scorer: null,
      },
      -1,
    ),
  tick: g => {
    const t = g.t + 1
    if (g.wait > 0) {
      const wait = g.wait - 1

      return { ...g, t, wait, scorer: wait > 0 ? g.scorer : null }
    }
    // The computer moves two ticks in three, so it can be beaten.
    let cpu = g.cpu
    if (t % 3 !== 0) {
      const middle = cpu + 1
      if (g.by < middle) cpu -= 1
      if (g.by > middle) cpu += 1
      cpu = clamp(cpu, 0, g.h - PADDLE)
    }
    let { dx, dy } = g
    let ny = g.by + dy
    if (ny < 0 || ny >= g.h) {
      dy = -dy
      ny = clamp(g.by + dy, 0, g.h - 1)
    }
    let nx = g.bx + dx
    if (nx <= 0) {
      if (ny >= g.you && ny < g.you + PADDLE) {
        dx = 1
        dy = deflect(g.you, ny, dy)
        nx = 1
      } else {
        return point({ ...g, t, cpu }, 'cpu')
      }
    } else if (nx >= g.w - 1) {
      if (ny >= cpu && ny < cpu + PADDLE) {
        dx = -1
        dy = deflect(cpu, ny, dy)
        nx = g.w - 2
      } else {
        return point({ ...g, t, cpu }, 'you')
      }
    }

    return { ...g, t, cpu, bx: nx, by: ny, dx, dy }
  },
  key: (g, dir) =>
    dir === 'up' || dir === 'down'
      ? { ...g, you: clamp(g.you + (dir === 'up' ? -1 : 1), 0, g.h - PADDLE) }
      : g,
  kindAt: (g, x, y) => {
    if (x === 0 && y >= g.you && y < g.you + PADDLE) return 'you'
    if (x === g.w - 1 && y >= g.cpu && y < g.cpu + PADDLE) return 'cpu'
    if (x === g.bx && y === g.by) return 'ball'
    if (isFlashing(g)) return g.scorer === 'you' ? 'flashGood' : 'flashBad'

    return 'empty'
  },
  score: g => g.youScore,
  isOver: g => g.youScore >= PONG_WIN || g.cpuScore >= PONG_WIN,
  status: g => {
    const score = `${g.youScore} : ${g.cpuScore}`
    if (g.youScore >= PONG_WIN) return `You win ${score}`
    if (g.cpuScore >= PONG_WIN) return `CPU wins ${score}`
    if (g.wait > 0) {
      const who =
        g.scorer === 'you'
          ? 'You score!'
          : g.scorer === 'cpu'
            ? 'CPU scores!'
            : 'Get ready'

      return `${who} ${score} · serve in ${secondsLeft(g)}`
    }

    return `You ${score} CPU`
  },
  // Worth keeping once a point is played, either way.
  hasProgress: g => g.youScore + g.cpuScore > 0,
}

// --- Bricks: bounce the ball off your paddle to clear the wall. 3 lives.

type Bricks = {
  w: number
  h: number
  bricks: string[]
  px: number
  bx: number
  by: number
  dx: number
  dy: number
  lives: number
  score: number
}

const BAT = 4

const relaunch = (g: Bricks): Bricks => ({
  ...g,
  bx: g.px + 1,
  by: g.h - 2,
  dx: 1,
  dy: -1,
})

const bricks: GameDef<Bricks> = {
  name: 'Bricks',
  speed: 330,
  help: 'left/right moves the paddle',
  init: (w, h) => {
    const rows = Math.min(3, Math.floor(h / 3))
    const wall: string[] = []
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < w; x++) wall.push(`${x},${y}`)
    }

    return relaunch({
      w,
      h,
      bricks: wall,
      px: Math.floor((w - BAT) / 2),
      bx: 0,
      by: 0,
      dx: 1,
      dy: -1,
      lives: 3,
      score: 0,
    })
  },
  tick: g => {
    let { dx, dy } = g
    if (g.bx + dx < 0 || g.bx + dx >= g.w) dx = -dx
    if (g.by + dy < 0) dy = -dy
    const nx = g.bx + dx
    const ny = g.by + dy
    const hit = `${nx},${ny}`
    if (g.bricks.includes(hit)) {
      return {
        ...g,
        dx,
        dy: -dy,
        bricks: g.bricks.filter(b => b !== hit),
        score: g.score + 1,
      }
    }
    if (ny >= g.h - 1) {
      if (nx >= g.px && nx < g.px + BAT) {
        return { ...g, dx: nx < g.px + BAT / 2 ? -1 : 1, dy: -1 }
      }
      const lives = g.lives - 1

      return lives > 0 ? relaunch({ ...g, lives }) : { ...g, lives }
    }

    return { ...g, dx, dy, bx: nx, by: ny }
  },
  key: (g, dir) =>
    dir === 'left' || dir === 'right'
      ? { ...g, px: clamp(g.px + (dir === 'left' ? -1 : 1), 0, g.w - BAT) }
      : g,
  kindAt: (g, x, y) => {
    if (y === g.h - 1 && x >= g.px && x < g.px + BAT) return 'you'
    if (x === g.bx && y === g.by) return 'ball'

    return g.bricks.includes(`${x},${y}`) ? 'brick' : 'empty'
  },
  score: g => g.score,
  isOver: g => g.lives <= 0 || g.bricks.length === 0,
  status: g =>
    g.bricks.length === 0
      ? `Cleared! ${g.score} bricks`
      : `Bricks ${g.score} · lives ${'♥'.repeat(g.lives)}`,
  // Worth keeping once a brick is hit or a life lost.
  hasProgress: g => g.score > 0 || g.lives < 3,
}

// --- Dodge: rocks fall from the top; stay out of their way.

type Dodge = {
  w: number
  h: number
  x: number
  rocks: Cell[]
  dodged: number
  t: number
  isOver: boolean
  seed: number
}

const DODGE_SLOW = 260
const DODGE_FAST = 130

// Rocks fall faster the more you have dodged: 1 ms quicker per rock, so
// top speed (twice the start) comes after 130 rocks.
const dodgeDelay = (g: Dodge) =>
  Math.max(DODGE_FAST, DODGE_SLOW - g.dodged)

const dodge: GameDef<Dodge> = {
  name: 'Dodge',
  speed: DODGE_SLOW,
  delay: dodgeDelay,
  help: 'left/right, dodge the rocks',
  init: (w, h, seed) => ({
    w,
    h,
    x: Math.floor(w / 2),
    rocks: [],
    dodged: 0,
    t: 0,
    isOver: false,
    seed: seed || 1,
  }),
  tick: g => {
    const t = g.t + 1
    let seed = g.seed
    const fallen = g.rocks.map(([x, y]): Cell => [x, y + 1])
    const kept = fallen.filter(([, y]) => y < g.h)
    const dodged = g.dodged + (fallen.length - kept.length)
    // How many new rocks: one about every fourth tick at first, every other
    // tick later on; from 40 dodged now and then a second one.
    seed = rand(seed)
    const chance = Math.min(50, 25 + Math.floor(dodged / 4))
    let count = pick(seed, 100) < chance ? 1 : 0
    seed = rand(seed)
    const pair = Math.min(20, Math.floor((dodged - 40) / 2))
    if (count && pair > 0 && pick(seed, 100) < pair) count = 2
    const row = new Set<number>()
    for (let i = 0; i < count; i++) {
      seed = rand(seed)
      // Mostly anywhere; one in six aimed near you, so no spot stays safe.
      const isAimed = pick(seed, 6) === 0
      seed = rand(seed)
      const x = isAimed
        ? clamp(g.x + pick(seed, 5) - 2, 0, g.w - 1)
        : pick(seed, g.w)
      // Never a full wall: at least two gaps in a row.
      if (row.size < g.w - 2) row.add(x)
    }
    for (const x of row) kept.push([x, 0])
    const isOver = kept.some(([x, y]) => x === g.x && y === g.h - 1)

    return { ...g, t, seed, rocks: kept, dodged, isOver }
  },
  key: (g, dir) => {
    if (dir !== 'left' && dir !== 'right') return g
    const x = clamp(g.x + (dir === 'left' ? -1 : 1), 0, g.w - 1)
    const isOver = g.rocks.some(([rx, ry]) => rx === x && ry === g.h - 1)

    return { ...g, x, isOver: g.isOver || isOver }
  },
  kindAt: (g, x, y) => {
    if (y === g.h - 1 && x === g.x) return 'you'

    return g.rocks.some(([rx, ry]) => rx === x && ry === y) ? 'rock' : 'empty'
  },
  score: g => g.dodged,
  isOver: g => g.isOver,
  status: g =>
    `Dodged ${g.dodged} · speed ${(DODGE_SLOW / dodgeDelay(g)).toFixed(1)}×`,
  // Worth keeping once a rock has passed.
  hasProgress: g => g.dodged > 0,
}

// The order the arcade swipes through.
// Chess first: it is the one that also plays online.
export const GAMES: GameDef<any>[] = [chess, snake, pong, bricks, dodge]
