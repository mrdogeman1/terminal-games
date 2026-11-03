import type { Host } from '../host'
import type { ChessEngine, EngineRequest } from './engine'

// Stockfish (GPLv3, see stockfish/COPYING) through `$.process.run`, one run
// per move. A running child's input cannot be written to, so the input ends
// with a second `setoption`: Stockfish takes it only after the search, where
// a closed input (read as `quit`) would stop the search at once.

// Per level 1-10: Skill Level (0-20) and how far it may search.
export const LEVELS: readonly { skill: number; go: string }[] = [
  { skill: 0, go: 'depth 1' },
  { skill: 0, go: 'depth 2' },
  { skill: 1, go: 'depth 3' },
  { skill: 3, go: 'depth 4' },
  { skill: 5, go: 'depth 6' },
  { skill: 8, go: 'depth 8' },
  { skill: 11, go: 'movetime 300' },
  { skill: 14, go: 'movetime 600' },
  { skill: 17, go: 'movetime 1000' },
  { skill: 20, go: 'movetime 1500' },
]

const RUN_MS = 15_000

export const stockfishInput = (request: EngineRequest): string => {
  const { skill, go } = LEVELS[Math.min(10, Math.max(1, request.level)) - 1]!
  const option = `setoption name Skill Level value ${skill}`

  return `${['uci', option, 'ucinewgame', `position fen ${request.fen}`, `go ${go}`, option].join('\n')}\n`
}

export const parseBestMove = (out: string): string | null =>
  /^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)\b/m.exec(out)?.[1] ?? null

// The binary in `dir`: stockfish.exe on Windows, stockfish elsewhere.
export async function findStockfish(host: Pick<Host, 'fs'>, dir: string): Promise<string | null> {
  for (const name of ['stockfish.exe', 'stockfish']) {
    const path = `${dir}/${name}`
    if (await host.fs.exists(path).catch(() => false)) return path
  }

  return null
}

export function createStockfishEngine(host: Pick<Host, 'fs' | 'process'>, dir: string): ChessEngine & {
  isAvailable(): Promise<boolean>
} {
  return {
    name: 'stockfish',
    isAvailable: async () => (await findStockfish(host, dir)) !== null,
    async bestMove(request) {
      try {
        const exe = await findStockfish(host, dir)
        if (!exe) return null
        const ran = await host.process.run([exe], { cwd: dir, stdin: stockfishInput(request), timeoutMs: RUN_MS })

        return parseBestMove(ran.stdout)
      } catch {
        return null
      }
    },
  }
}
