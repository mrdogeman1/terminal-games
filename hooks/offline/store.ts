import { STORE } from '../host'
import type { Host } from '../host'
import { isUuidV4 } from '../host'
import type { ModClient } from '../net/client'
import type { Color, GameResult, ImportResult, OfflineGame, OfflineReason } from '../net/protocol'

// Offline games (PROTOCOL.md 17): one pretty-printed JSON file per finished
// game under <dataDir>/games/, named <YYYYMMDD-HHmmss>-<clientId[0..8]>.json
// from playedAt (UTC). No account data, no token. Unfinished games stay in
// $.store, as the arcade keeps them.

const RESULTS: readonly GameResult[] = ['1-0', '0-1', '1/2-1/2']
const REASONS: readonly OfflineReason[] = [
  'checkmate', 'stalemate', 'insufficient_material', 'threefold', 'fifty_move', 'resign', 'max_plies',
]
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/
const BATCH = 50

export const gamesDir = (dataDir: string) => `${dataDir.replace(/[\\/]+$/, '')}/games`

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export const offlineFileName = (game: Pick<OfflineGame, 'clientId' | 'playedAt'>): string => {
  const d = new Date(game.playedAt)
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`

  return `${stamp}-${game.clientId.slice(0, 8)}.json`
}

// The file's word is not trusted: keep only a well-formed game.
export const readOfflineGameValue = (value: unknown): OfflineGame | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!isUuidV4(v.clientId)) return null
  if (typeof v.playedAt !== 'string' || Number.isNaN(Date.parse(v.playedAt))) return null
  if (v.color !== 'white' && v.color !== 'black') return null
  if (typeof v.engineLevel !== 'number' || !Number.isInteger(v.engineLevel)) return null
  if (v.engineLevel < 1 || v.engineLevel > 10) return null
  if (!RESULTS.includes(v.result as GameResult)) return null
  if (!REASONS.includes(v.reason as OfflineReason)) return null
  if (typeof v.pgn !== 'string') return null
  if (!Array.isArray(v.moves) || !v.moves.every(m => typeof m === 'string' && UCI.test(m))) return null

  return {
    clientId: v.clientId,
    playedAt: v.playedAt,
    color: v.color,
    engineLevel: v.engineLevel,
    result: v.result as GameResult,
    reason: v.reason as OfflineReason,
    pgn: v.pgn,
    moves: [...(v.moves as string[])],
  }
}

// The PGN of a finished offline game: the headers of 17.2 and the movetext
// the caller built from SAN (the chess rules come with the port).
export const offlinePgn = (
  game: Pick<OfflineGame, 'playedAt' | 'color' | 'engineLevel' | 'result'>,
  movetext: string,
): string => {
  const d = new Date(game.playedAt)
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`
  const engine = `Engine level ${game.engineLevel}`
  const [white, black] = game.color === 'white' ? ['You', engine] : [engine, 'You']
  const headers = [
    ['Event', 'Terminal Games offline'],
    ['Site', 'Claude Code'],
    ['Date', date],
    ['White', white],
    ['Black', black],
    ['Result', game.result],
  ]

  return `${headers.map(([k, v]) => `[${k} "${v}"]`).join('\n')}\n\n${movetext.trim()} ${game.result}`.trimEnd()
}

export type UploadedEntry = { gameId: string | null; status: ImportResult['status']; at: string }
export type UploadedMap = Record<string, UploadedEntry>

export const readUploadedValue = (value: unknown): UploadedMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: UploadedMap = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as Partial<UploadedEntry> | null
    if (!e || !['created', 'duplicate', 'invalid'].includes(e.status as string)) continue
    out[id] = {
      gameId: typeof e.gameId === 'string' ? e.gameId : null,
      status: e.status as UploadedEntry['status'],
      at: typeof e.at === 'string' ? e.at : '',
    }
  }

  return out
}

export type StoredOfflineGame = { path: string; game: OfflineGame }

export type UploadSummary = {
  sent: number
  created: number
  duplicate: number
  invalid: number
  // Games left for a later try (a batch failed: network, 5xx, 429).
  pending: number
  error: string | null
}

// The offline game store over `$.fs` and `$.store`.
export function createOfflineStore(host: Pick<Host, 'fs' | 'store' | 'clock'>, dataDir: string) {
  const dir = gamesDir(dataDir)

  const write = async (game: OfflineGame): Promise<string> => {
    const valid = readOfflineGameValue(game)
    if (!valid) throw new Error('Not a finished offline game')
    const path = `${dir}/${offlineFileName(valid)}`
    await host.fs.write(path, `${JSON.stringify(valid, null, 2)}\n`)

    return path
  }

  const read = async (path: string): Promise<OfflineGame | null> => {
    try {
      return readOfflineGameValue(JSON.parse(await host.fs.read(path)))
    } catch {
      return null
    }
  }

  // Every readable game file, oldest first (file names sort by time).
  const list = async (): Promise<StoredOfflineGame[]> => {
    if (!(await host.fs.exists(dir).catch(() => false))) return []
    const entries = await host.fs.list(dir).catch(() => [])
    const names = entries
      .filter(e => e.kind === 'file' && !e.isLink && e.name.endsWith('.json'))
      .map(e => e.name)
      .sort()
    const out: StoredOfflineGame[] = []
    for (const name of names) {
      const path = `${dir}/${name}`
      const game = await read(path)
      if (game) out.push({ path, game })
    }

    return out
  }

  const uploaded = async (): Promise<UploadedMap> =>
    readUploadedValue(await host.store.get(STORE.uploaded).catch(() => undefined))

  // Sends every game whose clientId is not yet in "offline.uploaded" (17.3)
  // in batches of 50, recording each result. The server is idempotent per
  // clientId, so a batch whose answer was lost is simply sent again later.
  const uploadPending = async (client: Pick<ModClient, 'importOffline'>): Promise<UploadSummary> => {
    const done = await uploaded()
    const todo = (await list()).map(s => s.game).filter(g => !(g.clientId in done))
    const summary: UploadSummary = { sent: 0, created: 0, duplicate: 0, invalid: 0, pending: todo.length, error: null }
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH)
      let results: ImportResult[]
      try {
        results = (await client.importOffline(batch)).results ?? []
      } catch (error) {
        summary.error = (error as Error).message

        return summary
      }
      const at = new Date(await host.clock.now()).toISOString()
      const sentIds = new Set(batch.map(g => g.clientId))
      for (const r of results) {
        if (!sentIds.has(r.clientId)) continue
        done[r.clientId] = { gameId: r.gameId ?? null, status: r.status, at }
        summary[r.status]++
      }
      summary.sent += batch.length
      summary.pending = todo.filter(g => !(g.clientId in done)).length
      await host.store.set(STORE.uploaded, done)
    }

    return summary
  }

  return { dir, write, read, list, uploaded, uploadPending }
}

export type OfflineStore = ReturnType<typeof createOfflineStore>

// Where the mod keeps its files: the `dataDir` setting, else
// <CLAUDE_CONFIG_DIR or ~/.claude>/terminal-games. Not the plugin folder: an
// update replaces that.
export const resolveDataDir = (setting: unknown, env: { configDir?: string; home?: string }): string => {
  const own = typeof setting === 'string' ? setting.trim() : ''
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (own) return norm(own)
  if (env.configDir) return `${norm(env.configDir)}/terminal-games`

  return `${norm(env.home ?? '.')}/.claude/terminal-games`
}

// Records the start of a game that may end up in a file: its clientId and
// time are fixed when the game starts (17.2).
export const newOfflineGameId = (makeId: () => string, now: number, color: Color, engineLevel: number) => ({
  clientId: makeId(),
  playedAt: new Date(now).toISOString(),
  color,
  engineLevel,
})
