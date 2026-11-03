import { expect, test } from 'claude-code/testing'

import type { Chess } from '../hooks/games/chess'
import { LEVELS, chess, fromFen, isRandomTurn, legalMoves, movetext, play, replay, sanOf, sq, squareAt, toFen } from '../hooks/games/chess'
import { LEVELS as SF_LEVELS } from '../hooks/engine/stockfish'

const perft = (s: Chess, depth: number): number => {
  if (depth === 0) return 1
  let n = 0
  for (const m of legalMoves(s)) n += perft(play(s, m), depth - 1)
  return n
}

// You move by clicking the piece, then its square.
const move = (s: Chess, from: string, to: string) => {
  const picked = chess.click!(s, sq(from) % 8, Math.floor(sq(from) / 8))
  return chess.click!(picked, sq(to) % 8, Math.floor(sq(to) / 8))
}

test('move counts from the start match the known numbers', async () => {
  const s = chess.init(8, 8, 1)
  expect(perft(s, 1)).toBe(20)
  expect(perft(s, 2)).toBe(400)
  expect(perft(s, 3)).toBe(8902)
})

test('move counts in a busy position (castling, pins, en passant)', async () => {
  const kiwipete = fromFen(
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -',
  )
  expect(perft(kiwipete, 1)).toBe(48)
  expect(perft(kiwipete, 2)).toBe(2039)
  const endgame = fromFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -')
  expect(perft(endgame, 1)).toBe(14)
  expect(perft(endgame, 2)).toBe(191)
  expect(perft(endgame, 3)).toBe(2812)
})

test('checkmate ends the game', async () => {
  // The quickest mate there is, played against you.
  let s = chess.init(8, 8, 1)
  s = move(s, 'f2', 'f3')
  s = play(s, legalMoves(s).find(m => m.from === sq('e7') && m.to === sq('e5'))!)
  s = move(s, 'g2', 'g4')
  expect(s.turn).toBe('b')
  const mate = chess.tick(s)
  expect(mate.result).toBe('b')
  expect(chess.isOver(mate)).toBe(true)
  expect(chess.status(mate)).toBe('Checkmate, CPU wins')
})

test('you can checkmate the computer', async () => {
  // The rook on h7 shuts the seventh row; the other one closes the eighth.
  const s = move(fromFen('k7/7R/8/8/8/8/8/K5R1 w - -'), 'g1', 'g8')
  expect(chess.status(s)).toBe('Checkmate, you win!')
})

test('stalemate is a draw', async () => {
  const s = fromFen('7k/5Q2/6K1/8/8/8/8/8 b - -')
  expect(s.result).toBe('draw')
  expect(chess.status(s)).toBe('Draw: stalemate')
})

test('castling moves the rook too, and never through check', async () => {
  const s = move(fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq -'), 'e1', 'g1')
  expect(s.board[sq('g1')]).toBe('wK')
  expect(s.board[sq('f1')]).toBe('wR')
  expect(s.board[sq('h1')]).toBe('')
  expect(s.castle).toBe('kq')

  // A black rook watches f1: no short castling.
  const blocked = chess.click!(
    fromFen('k4r2/8/8/8/8/8/8/R3K2R w KQ -'),
    4,
    7,
  )
  expect(blocked.targets).not.toContain(sq('g1'))
  expect(blocked.targets).toContain(sq('c1'))
})

test('en passant takes the pawn beside you', async () => {
  const s = move(fromFen('k7/8/8/3pP3/8/8/8/K7 w - d6'), 'e5', 'd6')
  expect(s.board[sq('d6')]).toBe('wP')
  expect(s.board[sq('d5')]).toBe('')
  expect(chess.score(s)).toBe(1)
})

test('a pawn reaching the end becomes a queen', async () => {
  const s = move(fromFen('8/P6k/8/8/8/8/8/K7 w - -'), 'a7', 'a8')
  expect(s.board[sq('a8')]).toBe('wQ')
})

test('you cannot move into check or move the other side', async () => {
  // The king may not step onto a square the rook covers.
  const s = chess.click!(fromFen('k7/8/8/8/8/8/1r6/4K3 w - -'), 4, 7)
  expect(s.targets.some(t => Math.floor(t / 8) === 6)).toBe(false)
  // Clicking a black piece selects nothing.
  const none = chess.click!(chess.init(8, 8, 1), 4, 1)
  expect(none.sel).toBe(-1)
})

test('the computer takes a free queen and finds a mate in one', async () => {
  const grab = chess.tick(fromFen('k2r4/8/8/8/3Q4/8/8/K7 b - -'))
  expect(grab.board[sq('d4')]).toBe('bR')

  const mate = chess.tick(fromFen('k7/8/8/8/8/1r6/r7/7K b - -'))
  expect(mate.result).toBe('b')
})

test('the computer answers within half a second', async () => {
  for (const fen of [
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b KQkq -',
  ]) {
    const t0 = Date.now()
    const s = chess.tick(fromFen(fen))
    const ms = Date.now() - t0
    expect(s.turn).toBe('w')
    expect([fen.slice(0, 8), ms < 500]).toEqual([fen.slice(0, 8), true])
  }
})

test('a new game keeps the letters setting; G switches it', async () => {
  const old = chess.other!(chess.init(8, 8, 1), 'g')
  expect(old.isLetters).toBe(true)
  expect(chess.carry!(old, chess.init(8, 8, 2)).isLetters).toBe(true)
  expect(chess.other!(old, 'G').isLetters).toBe(false)
  // Other keys change nothing.
  expect(chess.other!(old, 'x')).toBe(old)
})

test('pawns are drawn with a symbol that is no emoji, in their side colour', async () => {
  const s = chess.init(8, 8, 1)
  const white = chess.lookAt!(s, 0, 6)
  const black = chess.lookAt!(s, 0, 1)
  expect(white.t).toBe('♙ ')
  expect(black.t).toBe('♙ ')
  expect(white.c).toBe('#ffffff')
  expect(black.c).toBe('#000000')
  // No piece uses the emoji pawn or a variation selector.
  for (let i = 0; i < 64; i++) {
    const t = chess.lookAt!(s, i % 8, Math.floor(i / 8)).t
    expect(/[♟︎️]/.test(t)).toBe(false)
  }
})

test('FEN out: the start, after e4, castling and en passant kept', async () => {
  const s = chess.init(8, 8, 1)
  expect(toFen(s)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
  const e4 = move(s, 'e2', 'e4')
  expect(toFen(e4)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -'
  expect(toFen(fromFen(fen))).toBe(`${fen} 0 1`)
})

test('the engine answer is played when legal, ignored when not', async () => {
  const e4 = move(chess.init(8, 8, 1), 'e2', 'e4')
  const answered = chess.answer!(e4, 'e7e5')
  expect(answered.turn).toBe('w')
  expect(answered.board[sq('e5')]).toBe('bP')
  expect(chess.answer!(e4, 'e7e4')).toBe(e4)
  expect(chess.answer!(e4, 'nonsense')).toBe(e4)
  // Your own turn: nothing to answer.
  expect(chess.answer!(answered, 'd2d4')).toBe(answered)
  // An engine underpromotion is played as that piece.
  const promo = fromFen('7k/8/8/8/8/8/p7/4K3 b - -')
  expect(chess.answer!(promo, 'a2a1n').board[sq('a1')]).toBe('bN')
})

test('levels: random moves at 1-3 only, the engine asked otherwise', async () => {
  const share = (level: number) => {
    let n = 0
    for (let seed = 1; seed <= 400; seed++) {
      const s = { ...move(chess.init(8, 8, seed), 'e2', 'e4'), seed }
      if (isRandomTurn(s, level)) n++
    }
    return n / 400
  }
  expect(Math.abs(share(1) - 0.5)).toBeLessThan(0.08)
  expect(Math.abs(share(2) - 0.25)).toBeLessThan(0.07)
  expect(Math.abs(share(3) - 0.1)).toBeLessThan(0.05)
  expect(share(4)).toBe(0)
  expect(share(8)).toBe(0)
  const e4 = move(chess.init(8, 8, 1), 'e2', 'e4')
  expect(chess.ask!(e4, 8)).toBe(toFen(e4))
  expect(chess.ask!(chess.init(8, 8, 1), 8)).toBeNull()
  expect(LEVELS).toHaveLength(10)

})

test('the engine levels are the protocol levels 1-10', async () => {
  expect(LEVELS).toHaveLength(10)
  expect(SF_LEVELS).toHaveLength(LEVELS.length)
})

test('SAN: pieces, captures, disambiguation, castling, promotion, check and mate', async () => {
  const g = replay(['e2e4', 'd7d5', 'e4d5', 'g8f6', 'g1f3', 'b8d7', 'f1b5', 'c7c6', 'e1g1'])
  expect(g.sans).toEqual(['e4', 'd5', 'exd5', 'Nf6', 'Nf3', 'Nbd7', 'Bb5', 'c6', 'O-O'])
  expect(movetext(g.sans.slice(0, 3))).toBe('1. e4 d5 2. exd5')
  const promo = fromFen('3r3k/2P5/8/8/8/8/8/K7 w - -')
  const m = legalMoves(promo).find(x => x.to === sq('d8') && x.promo === 'N')!
  expect(sanOf(promo, m)).toBe('cxd8=N')
  const fools = replay(['f2f3', 'e7e5', 'g2g4', 'd8h4'])
  expect(fools.sans[3]).toBe('Qh4#')
  expect(fools.moves).toEqual(['f2f3', 'e7e5', 'g2g4', 'd8h4'])
  // A move that does not fit stops the replay there.
  expect(replay(['e2e4', 'e2e4']).plies).toBe(1)
})

test('U picks the promotion piece; the move is played as that piece', async () => {
  let s = fromFen('8/P6k/8/8/8/8/8/K7 w - -')
  s = chess.other!(s, 'u')
  expect(s.promo).toBe('R')
  expect(chess.status(s)).toMatch(/promotes to rook/)
  s = chess.other!(chess.other!(s, 'u'), 'u')
  expect(s.promo).toBe('N')
  const done = move(s, 'a7', 'a8')
  expect(done.board[sq('a8')]).toBe('wN')
  expect(done.moves).toEqual(['a7a8n'])
  expect(done.sans).toEqual(['a8=N'])
  expect(chess.other!(s, 'u').promo).toBe('Q')
})

test('playing black: the board is flipped, clicks map back, white moves first', async () => {
  const s = { ...chess.init(8, 8, 1), you: 'b' as const }
  // Top-left cell is h1 (a white rook), bottom-left is h8 (a black rook).
  expect(squareAt(s, 0, 0)).toBe(sq('h1'))
  expect(squareAt(s, 0, 7)).toBe(sq('h8'))
  expect(chess.lookAt!(s, 0, 7).c).toBe('#000000')
  // White to move: you can't, the computer can.
  expect(chess.click!(s, 3, 6)).toBe(s)
  expect(chess.ask!(s, 5)).toBe(toFen(s))
  const after = replay(['e2e4'], { you: 'b' })
  // e7 is screen (3, 6) for black.
  const picked = chess.click!(after, 3, 6)
  expect(picked.sel).toBe(sq('e7'))
  const moved = chess.click!(picked, 3, 4)
  expect(moved.moves).toEqual(['e2e4', 'e7e5'])
})

test('online: no local draws, no computer moves', async () => {
  const s = { ...fromFen('k7/8/8/8/8/8/8/K7 w - -'), isOnline: true, result: '' as const }
  const settled = move(s, 'a1', 'a2')
  expect(settled.board[sq('a2')]).toBe('wK')
  expect(settled.result).toBe('')
  const theirs = replay(['e2e4'], { isOnline: true })
  expect(chess.tick(theirs)).toBe(theirs)
  expect(chess.ask!(theirs, 5)).toBeNull()
  expect(chess.status(theirs)).toBe("Opponent's move")
})
test('a capture marks its square and is kept in the captured list', async () => {
  // White's e4 pawn takes d5.
  const s = fromFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -')
  expect(s.captured).toEqual([])
  const took = move(s, 'e4', 'd5')
  expect(took.lastTaken).toBe('bP')
  expect(took.takenAt).toBe(sq('d5'))
  expect(took.captured).toEqual(['bP'])
  expect(chess.status(took)).toBe('CPU is thinking…')
  expect(chess.lookAt!(took, 3, 3).bg).toBe('#f28482')
  expect(chess.lookAt!(took, 3, 3).t).toBe('♙ ')

  // Black's queen takes it back.
  const back = chess.answer!(took, 'd8d5')
  expect(back.lastTaken).toBe('wP')
  expect(back.captured).toEqual(['bP', 'wP'])
  expect(chess.status(back)).toBe('Your move (white)')
  // A quiet move clears the square mark but keeps the list.
  const quiet = move(back, 'g1', 'f3')
  expect(quiet.lastTaken).toBe('')
  expect(quiet.takenAt).toBe(-1)
  expect(quiet.captured).toEqual(['bP', 'wP'])
  expect(chess.status(quiet)).toBe('CPU is thinking…')
})

test('the tray lists what you took, a gap, what you lost', async () => {
  const none = chess.init(8, 8, 1)
  expect(chess.tray!(none)).toEqual([])

  const s = fromFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -')
  const took = move(s, 'e4', 'd5')
  // Only pieces you took: no gap. The last one is highlighted.
  expect(chess.tray!(took)).toEqual([
    { t: '♙', c: '#000000', bg: '#f28482', dim: false, b: true },
  ])

  // Black takes back: your pawn follows the gap; only the new loss is lit.
  const back = chess.answer!(took, 'd8d5')
  const tray = chess.tray!(back)
  expect(tray).toHaveLength(3)
  expect(tray[0]).toEqual({ t: '♙', c: '#000000', bg: '#a3b18a', dim: false, b: true })
  expect(tray[1]!.t).toBe('  ')
  expect(tray[2]).toEqual({ t: '♙', c: '#ffffff', bg: '#f28482', dim: false, b: true })

  // A quiet move: nothing is lit.
  const quiet = move(back, 'g1', 'f3')
  expect(chess.tray!(quiet).filter(l => l.bg === '#f28482')).toHaveLength(0)
  expect(chess.tray!(quiet)).toHaveLength(3)

  // Taken pieces keep their order and show their own symbol.
  const mixed = { ...quiet, captured: ['bN', 'bP', 'wQ', 'bR', 'wP'], lastTaken: '' }
  expect(chess.tray!(mixed).map(l => l.t)).toEqual(['♞', '♙', '♜', '  ', '♛', '♙'])

  // Letters mode draws letters.
  const letters = { ...mixed, isLetters: true }
  expect(chess.tray!(letters).map(l => l.t)).toEqual(['N', 'P', 'R', '  ', 'Q', 'P'])
})

test('a game has progress once a move was played', async () => {
  const s = chess.init(8, 8, 1)
  expect(chess.hasProgress!(s)).toBe(false)
  expect(chess.hasProgress!(move(s, 'e2', 'e4'))).toBe(true)
})

test('en passant marks the passed pawn square with a cross', async () => {
  const s = fromFen('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6')
  const took = move(s, 'e5', 'd6')
  expect(took.lastTaken).toBe('bP')
  expect(took.takenAt).toBe(sq('d5'))
  expect(chess.lookAt!(took, 3, 3)).toMatchObject({ t: '× ', bg: '#f28482' })
})
