// The computer opponent for offline chess. Stockfish when its binary is in
// stockfish/, else a built-in search. The built-in search and the chess
// rules come with the port of chess.ts; this file fixes the interface both
// sides meet at.

export type EngineLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

export type EngineRequest = {
  // The position to move in (FEN, side to move = the engine).
  fen: string
  // 1 (weakest) - 10, the `engineLevel` of PROTOCOL.md 5.
  level: number
}

export type EngineReply = {
  // UCI (`e7e5`, `a2a1q`), or null when the engine has no move.
  move: string | null
  // Which engine answered, for the pane and the debug log.
  by: string
}

export interface ChessEngine {
  readonly name: string
  // Resolves null when this engine cannot answer (missing, failed, timed
  // out); never rejects.
  bestMove(request: EngineRequest): Promise<string | null>
}

// The built-in search the port supplies (chess.ts's alpha-beta search,
// levels mapped onto 1-10). Synchronous in the old mod; kept async here so
// a later version may spread the search over clock ticks.
export interface FallbackEngine extends ChessEngine {
  readonly isBuiltIn: true
}

// Until the port lands: answers nothing, so the caller shows "no engine".
export const noFallback: FallbackEngine = {
  name: 'none',
  isBuiltIn: true,
  bestMove: async () => null,
}

const FEN = /^[1-8pnbrqkPNBRQK/]{15,90} [wb] (-|[KQkq]{1,4}) (-|[a-h][36]) \d{1,4} \d{1,4}$/

export const isEngineRequest = (value: unknown): value is EngineRequest => {
  const v = value as Partial<EngineRequest> | null
  return (
    !!v &&
    typeof v.fen === 'string' &&
    FEN.test(v.fen) &&
    typeof v.level === 'number' &&
    Number.isInteger(v.level) &&
    v.level >= 1 &&
    v.level <= 10
  )
}

// Tries each engine in order; the first move wins.
export function chainEngines(...engines: ChessEngine[]) {
  return {
    async move(request: EngineRequest): Promise<EngineReply> {
      if (!isEngineRequest(request)) return { move: null, by: 'none' }
      for (const engine of engines) {
        const move = await engine.bestMove(request).catch(() => null)
        if (move) return { move, by: engine.name }
      }

      return { move: null, by: 'none' }
    },
  }
}
