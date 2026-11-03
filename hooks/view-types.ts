import type { JsonValue } from 'claude-code'

// --- The Client view's props (plain JSON, every field present).

// A run of text; `act`, when not '', is what a click on it posts.
export type ViewSeg = { t: string; c: string; dim: boolean; b: boolean; act: string }
export type ViewRow = { segs: ViewSeg[] }

// The view asks the chess engine for a move: the position as FEN and the
// level (1 weakest). The reply names them again with the move in UCI form
// (`e7e5`, `a2a1q`), or null when there is no engine or it found none.
export type EngineAsk = { fen: string; level: number }
export type EngineReply = EngineAsk & { move: string | null }

// One game's unfinished play, kept between sessions: the game on the board
// (null for none), the ones put aside for a new game (newest first), and its
// speed (tenths) or level.
export type KeptGame = {
  current: JsonValue | null
  parked: JsonValue[]
  tenths?: number
  level?: number
}

// The online game on the board: its moves (UCI) from the start, your side,
// whether you may move now, and the rows drawn above (opponent) and below
// (you) it. `rev` changes with every answer to a move the view sent.
export type OnlineBoard = {
  id: string
  moves: string[]
  you: 'w' | 'b'
  canMove: boolean
  isOver: boolean
  status: string
  above: ViewRow
  below: ViewRow
  rev: number
}

// `top`: the account rows. `online`: the lobby or game rows, and the board,
// null while signed out. `best`/`games`: kept between sessions.
export type ViewProps = {
  top: ViewRow[]
  online: { rows: ViewRow[]; board: OnlineBoard | null } | null
  bodyRows: number
  best?: Record<string, number>
  engine?: EngineReply
  games?: Record<string, KeptGame>
}
