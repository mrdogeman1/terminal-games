// Chess: against the computer offline, or a board the online game drives.
// `you` is your side (the other is the computer, or the online opponent);
// the board is drawn from your side, so black sees it flipped. Squares are
// numbered 0-63 row by row from a8; a piece is its colour and letter, `wK`
// or `bP`, an empty square ''.

import type { Dir, GameDef, Look } from './games'
import { pick, rand } from './random'

export type Color = 'w' | 'b'
export type Promo = 'Q' | 'R' | 'B' | 'N'
export const PROMOS: readonly Promo[] = ['Q', 'R', 'B', 'N']

export type Move = {
  from: number
  to: number
  promo?: Promo
  castle?: 'K' | 'Q'
  isEp?: boolean
  isDouble?: boolean
}

export type Chess = {
  w: number
  h: number
  board: string[]
  turn: Color
  // Castling still allowed: K and Q for white's sides, k and q for black's.
  castle: string
  // The square a pawn passed over last move (en passant), or -1.
  ep: number
  sel: number
  // Where the selected piece may go.
  targets: number[]
  cursor: number
  // The cursor shows once arrow keys are used.
  isKeys: boolean
  last: number[]
  isCheck: boolean
  plies: number
  result: '' | Color | 'draw'
  reason: string
  // Points of material you have taken.
  taken: number
  seed: number
  // Pieces as letters (K Q R B N P) instead of chess symbols: for fonts
  // that draw the symbols badly. G switches.
  isLetters: boolean
  // The piece the last move took ('' for none) and the square it stood on
  // (the moved-to square, or the passed pawn's for en passant; -1 for none).
  lastTaken: string
  takenAt: number
  // Every piece taken so far, in the order taken (`bN`, `wP`).
  captured: string[]
  // Your side; the board is drawn from it (black: flipped).
  you: Color
  // The piece a pawn of yours becomes on the last rank (U switches).
  promo: Promo
  // The moves so far, in UCI (`e2e4`, `e7e8n`) and SAN (`e4`, `exd8=N+`).
  moves: string[]
  sans: string[]
  // Online: the server decides the end; local draws (move limit, bare
  // kings) are not called.
  isOnline: boolean
}

// After this many half-moves without an end, the game is a draw.
const MAX_PLIES = 300
// How far the computer looks ahead, in half-moves, plus captures after.
const DEPTH = 2
const QUIET_DEPTH = 3
// The computer picks at random among moves this close to its best (centipawns).
const SLACK = 12

const VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 }
const CENTI: Record<string, number> = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 }
const MATE = 100000

const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const KING = [...ROOK, ...BISHOP]

const X = (i: number) => i % 8
const Y = (i: number) => Math.floor(i / 8)
const at = (x: number, y: number) => y * 8 + x
const on = (x: number, y: number) => x >= 0 && x < 8 && y >= 0 && y < 8
const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

const BACK = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']

const start = (): string[] => [
  ...BACK.map(p => `b${p}`),
  ...Array<string>(8).fill('bP'),
  ...Array<string>(32).fill(''),
  ...Array<string>(8).fill('wP'),
  ...BACK.map(p => `w${p}`),
]

// Whether a piece of colour `by` attacks square `sq`.
export const isAttacked = (board: string[], sq: number, by: Color) => {
  const x = X(sq)
  const y = Y(sq)
  // A white pawn attacks upward, so it stands one row below.
  const py = by === 'w' ? y + 1 : y - 1
  for (const dx of [-1, 1]) {
    if (on(x + dx, py) && board[at(x + dx, py)] === `${by}P`) return true
  }
  for (const [dx, dy] of KNIGHT) {
    if (on(x + dx!, y + dy!) && board[at(x + dx!, y + dy!)] === `${by}N`) return true
  }
  for (const [dx, dy] of KING) {
    if (on(x + dx!, y + dy!) && board[at(x + dx!, y + dy!)] === `${by}K`) return true
  }
  const slide = (dirs: number[][], kinds: string[]) => {
    for (const [dx, dy] of dirs) {
      let nx = x + dx!
      let ny = y + dy!
      while (on(nx, ny)) {
        const p = board[at(nx, ny)]!
        if (p) {
          if (p[0] === by && kinds.includes(p[1]!)) return true
          break
        }
        nx += dx!
        ny += dy!
      }
    }
    return false
  }

  return slide(ROOK, ['R', 'Q']) || slide(BISHOP, ['B', 'Q'])
}

const inCheck = (board: string[], c: Color) =>
  isAttacked(board, board.indexOf(`${c}K`), other(c))

// Every move the side to move could make, before checking it leaves its
// own king safe.
const pseudoMoves = (s: Chess): Move[] => {
  const { board, turn: c } = s
  const moves: Move[] = []
  const foe = other(c)
  for (let i = 0; i < 64; i++) {
    const p = board[i]!
    if (!p || p[0] !== c) continue
    const x = X(i)
    const y = Y(i)
    const kind = p[1]
    if (kind === 'P') {
      const dir = c === 'w' ? -1 : 1
      const home = c === 'w' ? 6 : 1
      const end = c === 'w' ? 0 : 7
      const add = (to: number, extra: Partial<Move> = {}) => {
        if (Y(to) !== end) return void moves.push({ from: i, to, ...extra })
        for (const promo of PROMOS) moves.push({ from: i, to, promo, ...extra })
      }
      if (on(x, y + dir) && !board[at(x, y + dir)]) {
        add(at(x, y + dir))
        if (y === home && !board[at(x, y + 2 * dir)]) {
          add(at(x, y + 2 * dir), { isDouble: true })
        }
      }
      for (const dx of [-1, 1]) {
        if (!on(x + dx, y + dir)) continue
        const to = at(x + dx, y + dir)
        if (board[to] && board[to]![0] === foe) add(to)
        else if (to === s.ep) add(to, { isEp: true })
      }
      continue
    }
    const steps = (dirs: number[][], isSlide: boolean) => {
      for (const [dx, dy] of dirs) {
        let nx = x + dx!
        let ny = y + dy!
        while (on(nx, ny)) {
          const t = board[at(nx, ny)]!
          if (t && t[0] === c) break
          moves.push({ from: i, to: at(nx, ny) })
          if (t || !isSlide) break
          nx += dx!
          ny += dy!
        }
      }
    }
    if (kind === 'N') steps(KNIGHT, false)
    if (kind === 'B') steps(BISHOP, true)
    if (kind === 'R') steps(ROOK, true)
    if (kind === 'Q') steps(KING, true)
    if (kind === 'K') {
      steps(KING, false)
      const row = c === 'w' ? 7 : 0
      if (i === at(4, row) && !isAttacked(board, i, foe)) {
        const [kSide, qSide] = c === 'w' ? ['K', 'Q'] : ['k', 'q']
        if (
          s.castle.includes(kSide!) &&
          board[at(7, row)] === `${c}R` &&
          !board[at(5, row)] &&
          !board[at(6, row)] &&
          !isAttacked(board, at(5, row), foe) &&
          !isAttacked(board, at(6, row), foe)
        ) {
          moves.push({ from: i, to: at(6, row), castle: 'K' })
        }
        if (
          s.castle.includes(qSide!) &&
          board[at(0, row)] === `${c}R` &&
          !board[at(1, row)] &&
          !board[at(2, row)] &&
          !board[at(3, row)] &&
          !isAttacked(board, at(3, row), foe) &&
          !isAttacked(board, at(2, row), foe)
        ) {
          moves.push({ from: i, to: at(2, row), castle: 'Q' })
        }
      }
    }
  }

  return moves
}

// Corner squares and the castling right a rook there carries.
const CORNER: Record<number, string> = { 56: 'Q', 63: 'K', 0: 'q', 7: 'k' }

export const play = (s: Chess, m: Move): Chess => {
  const board = s.board.slice()
  const piece = board[m.from]!
  const c = piece[0] as Color
  let taken = board[m.to]!
  let takenAt = taken ? m.to : -1
  board[m.to] = m.promo ? `${c}${m.promo}` : piece
  board[m.from] = ''
  if (m.isEp) {
    const sq = at(X(m.to), Y(m.from))
    taken = board[sq]!
    takenAt = sq
    board[sq] = ''
  }
  if (m.castle) {
    const row = Y(m.from)
    const [rf, rt] = m.castle === 'K' ? [7, 5] : [0, 3]
    board[at(rt, row)] = board[at(rf, row)]!
    board[at(rf, row)] = ''
  }
  let castle = s.castle
  if (piece[1] === 'K') castle = castle.replace(c === 'w' ? /[KQ]/g : /[kq]/g, '')
  for (const sq of [m.from, m.to]) {
    const right = CORNER[sq]
    if (right) castle = castle.replace(right, '')
  }

  return {
    ...s,
    board,
    turn: other(c),
    castle,
    ep: m.isDouble ? at(X(m.from), (Y(m.from) + Y(m.to)) / 2) : -1,
    last: [m.from, m.to],
    plies: s.plies + 1,
    lastTaken: taken,
    takenAt,
    captured: taken ? [...s.captured, taken] : s.captured,
    sel: -1,
    targets: [],
    taken: s.taken + (c === s.you && taken ? VALUE[taken[1]!]! : 0),
  }
}

export const legalMoves = (s: Chess): Move[] =>
  pseudoMoves(s).filter(m => !inCheck(play(s, m).board, s.turn))

// Settles check, mate and draws for the side now to move.
export const settle = (s: Chess): Chess => {
  const isCheck = inCheck(s.board, s.turn)
  if (legalMoves(s).length === 0) {
    return isCheck
      ? { ...s, isCheck, result: other(s.turn), reason: 'checkmate' }
      : { ...s, isCheck, result: 'draw', reason: 'stalemate' }
  }
  if (s.isOnline) return { ...s, isCheck }
  if (s.board.every(p => !p || p[1] === 'K')) {
    return { ...s, isCheck, result: 'draw', reason: 'only kings left' }
  }
  if (s.plies >= MAX_PLIES) {
    return { ...s, isCheck, result: 'draw', reason: 'move limit' }
  }

  return { ...s, isCheck }
}

// The position for the side to move, in centipawns: material plus a little
// for centred knights and bishops and for pawns that have marched.
const evaluate = (s: Chess) => {
  let score = 0
  for (let i = 0; i < 64; i++) {
    const p = s.board[i]!
    if (!p) continue
    const kind = p[1]!
    const x = X(i)
    const y = Y(i)
    let v = CENTI[kind]!
    const centre = 3.5 - Math.max(Math.abs(x - 3.5), Math.abs(y - 3.5))
    if (kind === 'N') v += centre * 10
    if (kind === 'B') v += centre * 5
    if (kind === 'P') v += (p[0] === 'w' ? 6 - y : y - 1) * 8
    score += p[0] === 'w' ? v : -v
  }

  return s.turn === 'w' ? score : -score
}

// Captures first, the most valuable victim first.
const ordered = (s: Chess, moves: Move[]) =>
  moves
    .map(m => ({ m, v: (s.board[m.to] ? CENTI[s.board[m.to]![1]!]! : 0) + (m.promo ? CENTI[m.promo]! - 100 : 0) }))
    .sort((a, b) => b.v - a.v)
    .map(o => o.m)

// Positions the search may visit for one move; past it, it stops looking
// further than the position at hand, so a reply never takes long.
const NODE_BUDGET = 6000
let nodes = 0

// Captures only, until things are calm: so the search does not stop in the
// middle of an exchange. Legality is checked only for the captures tried.
const quiet = (s: Chess, alpha: number, beta: number, depth: number): number => {
  nodes++
  const stand = evaluate(s)
  if (depth === 0 || stand >= beta || nodes > NODE_BUDGET) return stand
  let best = Math.max(alpha, stand)
  const captures = pseudoMoves(s).filter(m => s.board[m.to] || m.isEp)
  for (const m of ordered(s, captures)) {
    const next = play(s, m)
    if (inCheck(next.board, s.turn)) continue
    const v = -quiet(next, -beta, -best, depth - 1)
    if (v >= beta) return v
    if (v > best) best = v
  }

  return best
}

const search = (s: Chess, depth: number, alpha: number, beta: number): number => {
  nodes++
  const moves = legalMoves(s)
  if (moves.length === 0) {
    return inCheck(s.board, s.turn) ? -MATE + s.plies : 0
  }
  if (depth === 0 || nodes > NODE_BUDGET) {
    return quiet(s, alpha, beta, QUIET_DEPTH)
  }
  let best = -Infinity
  for (const m of ordered(s, moves)) {
    const v = -search(play(s, m), depth - 1, -beta, -Math.max(alpha, best))
    if (v > best) best = v
    if (best >= beta) break
  }

  return best
}

// The computer's strength, weakest first. Stockfish plays it (see
// hooks/engine.ts); where Stockfish is missing, the built-in search below.
// Ten levels, as PROTOCOL.md's engine levels 1-10.
export const LEVELS = [
  'Beginner',
  'Novice',
  'Casual',
  'Club',
  'Strong',
  'Expert',
  'Master',
  'Senior master',
  'Grandmaster',
  'Max',
] as const
export const DEFAULT_LEVEL = 3
// At the weakest levels the computer plays any legal move this often.
const RANDOM_SHARE = [0.5, 0.25, 0.1]

// Whether the computer's coming move is a random one: fixed per game and
// move, so asking twice gives the same answer.
export const isRandomTurn = (s: Chess, level: number) =>
  pick(rand((s.seed ^ Math.imul(s.plies + 1, 0x9e3779b1)) >>> 0), 1000) <
  (RANDOM_SHARE[level - 1] ?? 0) * 1000

const randomMove = (s: Chess): { move: Move; seed: number } | null => {
  const moves = legalMoves(s)
  if (moves.length === 0) return null
  const seed = rand(s.seed)

  return { move: moves[pick(seed, moves.length)]!, seed }
}

export const name = (i: number) => `${String.fromCharCode(97 + X(i))}${8 - Y(i)}`

export const uciOf = (m: Move) => `${name(m.from)}${name(m.to)}${m.promo ? m.promo.toLowerCase() : ''}`

// A move in standard notation, for the position before it: `Nbd7`, `exd5`,
// `O-O`, `e8=Q+`, `Qh7#`.
export const sanOf = (s: Chess, m: Move): string => {
  const piece = s.board[m.from]!
  const kind = piece[1]!
  const after = settle({ ...play(s, m), isOnline: false, plies: 0 })
  const mark = after.result && after.reason === 'checkmate' ? '#' : after.isCheck ? '+' : ''
  if (m.castle) return `${m.castle === 'K' ? 'O-O' : 'O-O-O'}${mark}`
  const isCapture = !!s.board[m.to] || !!m.isEp
  if (kind === 'P') {
    const from = isCapture ? `${name(m.from)[0]}x` : ''
    return `${from}${name(m.to)}${m.promo ? `=${m.promo}` : ''}${mark}`
  }
  const rivals = legalMoves(s).filter(
    o => o.to === m.to && o.from !== m.from && s.board[o.from] === piece,
  )
  let which = ''
  if (rivals.length) {
    const isFileShared = rivals.some(o => X(o.from) === X(m.from))
    const isRankShared = rivals.some(o => Y(o.from) === Y(m.from))
    which = !isFileShared ? name(m.from)[0]! : !isRankShared ? name(m.from)[1]! : name(m.from)
  }

  return `${kind}${which}${isCapture ? 'x' : ''}${name(m.to)}${mark}`
}

// Plays a move for real: the position settled, the move written down.
export const commit = (s: Chess, m: Move): Chess => {
  const san = sanOf(s, m)

  return settle({ ...play(s, m), moves: [...s.moves, uciOf(m)], sans: [...s.sans, san] })
}

// The legal move a UCI string names (no promotion letter: a queen), or null.
export const moveOf = (s: Chess, uci: string): Move | null => {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci)
  if (!m) return null
  const promo = (m[3]?.toUpperCase() ?? 'Q') as Promo

  return (
    legalMoves(s).find(
      one => one.from === sq(m[1]!) && one.to === sq(m[2]!) && (!one.promo || one.promo === promo),
    ) ?? null
  )
}

// A game from its UCI moves, played from the start; stops at the first
// move that does not fit (the server's list is trusted, but not blindly).
export const replay = (uci: readonly string[], base: Partial<Chess> = {}): Chess => {
  let s: Chess = { ...chess.init(8, 8, 1), ...base }
  for (const one of uci) {
    const m = moveOf(s, one)
    if (!m) break
    s = commit(s, m)
  }

  return s
}

// The game as PGN movetext: `1. e4 e5 2. Nf3`.
export const movetext = (sans: readonly string[]) =>
  sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ')

// Screen cell (x, y) to board square, as drawn from your side.
export const squareAt = (g: Chess, x: number, y: number) =>
  g.you === 'b' ? at(7 - x, 7 - y) : at(x, y)

// The position as FEN, for the engine. No halfmove clock is kept: 0.
export const toFen = (s: Chess) => {
  const rows: string[] = []
  for (let y = 0; y < 8; y++) {
    let row = ''
    let gap = 0
    for (let x = 0; x < 8; x++) {
      const p = s.board[at(x, y)]!
      if (!p) {
        gap++
        continue
      }
      if (gap) row += gap
      gap = 0
      row += p[0] === 'w' ? p[1] : p[1]!.toLowerCase()
    }
    rows.push(gap ? row + gap : row)
  }
  const ep = s.ep >= 0 ? name(s.ep) : '-'

  return `${rows.join('/')} ${s.turn} ${s.castle || '-'} ${ep} 0 ${Math.floor(s.plies / 2) + 1}`
}

// The computer's move: the best it sees, a random one among near-equals.
export const bestMove = (s: Chess): { move: Move; seed: number } | null => {
  const moves = ordered(s, legalMoves(s))
  if (moves.length === 0) return null
  nodes = 0
  const scored = moves.map(m => ({ m, v: -search(play(s, m), DEPTH - 1, -Infinity, Infinity) }))
  const top = Math.max(...scored.map(o => o.v))
  const near = scored.filter(o => o.v >= top - SLACK)
  const seed = rand(s.seed)

  return { move: near[pick(seed, near.length)]!.m, seed }
}

const LIGHT = '#a3b18a'
const DARK = '#588157'
const LAST_LIGHT = '#c9c27a'
const LAST_DARK = '#a39a4f'
const SELECTED = '#e9c46a'
const CAPTURE = '#e76f51'
const CHECK = '#d62828'
const CURSOR = '#48cae4'
// Where the last move took a piece.
const TAKEN = '#f28482'

// The filled symbols for both sides, coloured white or black: they read
// better on the board than the outlined white set. The pawn is the outlined
// one: the filled pawn (U+265F) is also an emoji, and Windows Terminal draws
// it as a purple emoji whatever the colour, a text-style selector or not.
const SYMBOL: Record<string, string> = {
  K: '♚',
  Q: '♛',
  R: '♜',
  B: '♝',
  N: '♞',
  P: '♙',
}

const PROMO_WORD: Record<Promo, string> = { Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' }

// The screen cell a square draws at: the inverse of squareAt.
const cellOf = (g: Chess, i: number): [number, number] =>
  g.you === 'b' ? [7 - X(i), 7 - Y(i)] : [X(i), Y(i)]

export const chess: GameDef<Chess> = {
  name: 'Chess',
  speed: 450,
  help: 'click a piece, then a square · G letters · U promotion · − + level',
  size: [8, 8],
  hasBest: false,
  init: (_w, _h, seed) => ({
    w: 8,
    h: 8,
    board: start(),
    turn: 'w',
    castle: 'KQkq',
    ep: -1,
    sel: -1,
    targets: [],
    cursor: at(4, 6),
    isKeys: false,
    last: [],
    isCheck: false,
    plies: 0,
    result: '',
    reason: '',
    taken: 0,
    seed: seed || 1,
    isLetters: false,
    lastTaken: '',
    takenAt: -1,
    captured: [],
    you: 'w',
    promo: 'Q',
    moves: [],
    sans: [],
    isOnline: false,
  }),
  // A new game keeps the piece style and promotion choice of the last one.
  carry: (old, fresh) => ({ ...fresh, isLetters: old.isLetters, promo: old.promo ?? 'Q' }),
  other: (g, key) => {
    if (key === 'g' || key === 'G') return { ...g, isLetters: !g.isLetters }
    if (key === 'u' || key === 'U') {
      return { ...g, promo: PROMOS[(PROMOS.indexOf(g.promo) + 1) % PROMOS.length]! }
    }

    return g
  },
  levels: LEVELS,
  defaultLevel: DEFAULT_LEVEL,
  // The engine is asked for the computer's move, unless it's a random one.
  ask: (g, level) =>
    g.isOnline || g.result || g.turn === g.you || isRandomTurn(g, level) ? null : toFen(g),
  // A move in UCI form (`e7e5`, `a2a1n`).
  answer: (g, uci) => {
    if (g.isOnline || g.result || g.turn === g.you) return g
    const move = moveOf(g, uci)

    return move ? { ...commit(g, move), seed: rand(g.seed) } : g
  },
  // Without an engine answer, the computer moves on the tick after yours:
  // a random move where the level says so, else the built-in search's.
  tick: (g, level = DEFAULT_LEVEL) => {
    if (g.isOnline || g.result || g.turn === g.you) return g
    const pickd = isRandomTurn(g, level) ? randomMove(g) : bestMove(g)
    if (!pickd) return settle(g)

    return { ...commit(g, pickd.move), seed: pickd.seed }
  },
  click: (g, x, y) => {
    if (g.result || g.turn !== g.you || !on(x, y)) return g
    const i = squareAt(g, x, y)
    if (g.sel >= 0 && g.targets.includes(i)) {
      const m = legalMoves(g).find(
        one => one.from === g.sel && one.to === i && (!one.promo || one.promo === g.promo),
      )
      if (m) return { ...commit(g, m), cursor: i }
    }
    const p = g.board[i]
    if (p && p[0] === g.you && i !== g.sel) {
      const targets = [...new Set(legalMoves(g).filter(m => m.from === i).map(m => m.to))]

      return { ...g, sel: i, targets, cursor: i }
    }

    return { ...g, sel: -1, targets: [], cursor: i }
  },
  // Arrow keys move the cursor on the screen, whichever way the board faces.
  key: (g, dir: Dir) => {
    const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir]
    const [cx, cy] = cellOf(g, g.cursor)
    const x = Math.max(0, Math.min(7, cx + dx!))
    const y = Math.max(0, Math.min(7, cy + dy!))

    return { ...g, cursor: squareAt(g, x, y), isKeys: true }
  },
  press: g => {
    const [cx, cy] = cellOf(g, g.cursor)
    const next = chess.click!(g, cx, cy)

    return { ...next, isKeys: true }
  },
  kindAt: () => 'empty',
  lookAt: (g, x, y): Look => {
    const i = squareAt(g, x, y)
    const isLight = (X(i) + Y(i)) % 2 === 0
    let bg = isLight ? LIGHT : DARK
    if (g.last.includes(i)) bg = isLight ? LAST_LIGHT : LAST_DARK
    const isTaken = i === g.takenAt
    if (isTaken) bg = TAKEN
    if (i === g.sel) bg = SELECTED
    const p = g.board[i]!
    if (g.isCheck && p === `${g.turn}K`) bg = CHECK
    const isTarget = g.targets.includes(i)
    if (isTarget && p) bg = CAPTURE
    if (g.isKeys && i === g.cursor && !g.result) bg = CURSOR
    if (p) {
      return {
        t: `${g.isLetters ? p[1] : SYMBOL[p[1]!]} `,
        c: p[0] === 'w' ? '#ffffff' : '#000000',
        bg,
        dim: false,
        b: true,
      }
    }

    // An en passant pawn's empty square shows a cross.
    return {
      t: isTarget ? '• ' : isTaken ? '× ' : '  ',
      c: '#1b263b',
      bg,
      dim: false,
      b: isTaken,
    }
  },
  score: g => g.taken,
  isOver: g => g.result !== '',
  status: g => {
    const mine = g.you === 'w' ? 'white' : 'black'
    if (g.result === g.you) return 'Checkmate, you win!'
    if (g.result && g.result !== 'draw') return g.isOnline ? 'Checkmate, you lose' : 'Checkmate, CPU wins'
    if (g.result === 'draw') return `Draw: ${g.reason}`
    if (g.turn !== g.you) return g.isOnline ? "Opponent's move" : 'CPU is thinking…'
    const promo = g.promo === 'Q' ? '' : ` · promotes to ${PROMO_WORD[g.promo]}`
    if (g.isCheck) return `Check! Your move${promo}`

    return `${g.sel >= 0 ? 'Pick a square' : `Your move (${mine})`}${promo}`
  },
  // The row under the board: the pieces you took, a gap, then the pieces
  // you lost. The piece taken last gets the highlight colour.
  tray: g => {
    const lastIdx = g.lastTaken ? g.captured.length - 1 : -1
    const look = (p: string, i: number): Look => ({
      t: g.isLetters ? p[1]! : SYMBOL[p[1]!]!,
      c: p[0] === 'w' ? '#ffffff' : '#000000',
      bg: i === lastIdx ? TAKEN : LIGHT,
      dim: false,
      b: true,
    })
    const ours = g.captured.flatMap((p, i) => (p[0] !== g.you ? [look(p, i)] : []))
    const lost = g.captured.flatMap((p, i) => (p[0] === g.you ? [look(p, i)] : []))
    // The gap has no colours, so the terminal shows through.
    const gap: Look[] =
      ours.length && lost.length ? [{ t: '  ', c: '', bg: '', dim: false, b: false }] : []

    return [...ours, ...gap, ...lost]
  },
  hasProgress: g => g.plies > 0,
}

// A position from FEN (the board, side to move, castling, en passant), for tests.
export const fromFen = (fen: string): Chess => {
  const [rows = '', turn = 'w', castle = '-', ep = '-'] = fen.split(' ')
  const board: string[] = []
  for (const ch of rows.replace(/\//g, '')) {
    if (/\d/.test(ch)) board.push(...Array<string>(Number(ch)).fill(''))
    else board.push(`${ch === ch.toUpperCase() ? 'w' : 'b'}${ch.toUpperCase()}`)
  }
  const epSq =
    ep === '-' ? -1 : at(ep.charCodeAt(0) - 97, 8 - Number(ep[1]))

  return settle({
    ...chess.init(8, 8, 1),
    board,
    turn: turn as Color,
    castle: castle === '-' ? '' : castle,
    ep: epSq,
  })
}

// A square's number from its name: `e2` -> 52.
export const sq = (name: string) =>
  at(name.charCodeAt(0) - 97, 8 - Number(name[1]))
