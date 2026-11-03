import { expect, test } from 'claude-code/testing'

import { createClient } from '../hooks/net/client'
import type { ImportResult, OfflineGame } from '../hooks/net/protocol'
import { createOfflineStore, offlineFileName, offlinePgn, resolveDataDir } from '../hooks/offline/store'
import { CLIENT_ID, memoryHost, SERVER } from './kit'
import type { Sent } from './kit'

const DATA = 'C:/Users/x/.claude/terminal-games'

const game = (n: number, over: Partial<OfflineGame> = {}): OfflineGame => {
  const hex = n.toString(16).padStart(8, '0')
  const base = {
    clientId: `${hex}-3c1a-4c7e-9a51-0b8f0b6a2e11`,
    playedAt: new Date(Date.UTC(2026, 10, 2, 20, 14, 3) + n * 1000).toISOString(),
    color: 'white' as const,
    engineLevel: 4,
    result: '1-0' as const,
    reason: 'checkmate' as const,
    moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'],
  }

  const { moves, ...head } = base

  // Field order as in the protocol's example file.
  return { ...head, pgn: offlinePgn(base, '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#'), moves, ...over }
}

test('one readable JSON file per game, named by time and clientId, read back the same', async () => {
  const host = memoryHost()
  const store = createOfflineStore(host, `${DATA}/`)
  const g = game(1)
  const path = await store.write(g)

  expect(offlineFileName(game(0))).toBe('20261102-201403-00000000.json')
  expect(path).toBe(`${DATA}/games/20261102-201404-00000001.json`)
  expect(host.files[path]).toBe(`${JSON.stringify(g, null, 2)}\n`)
  expect(host.files[path]).not.toMatch(/token|Bearer/)
  expect(await store.read(path)).toEqual(g)
  expect((await store.list()).map(s => s.game)).toEqual([g])
  expect(g.pgn).toMatch(/^\[Event "Claude Games offline"\]\n\[Site "Claude Code"\]\n\[Date "2026\.11\.02"\]\n\[White "You"\]\n\[Black "Engine level 4"\]\n\[Result "1-0"\]\n\n1\. e4/)
  expect(g.pgn.endsWith('Qxf7# 1-0')).toBe(true)
})

test('broken or foreign files are skipped, bad games are not written', async () => {
  const host = memoryHost()
  const store = createOfflineStore(host, DATA)
  host.files[`${DATA}/games/notes.txt`] = 'hello'
  host.files[`${DATA}/games/broken.json`] = '{ nope'
  host.files[`${DATA}/games/wrong.json`] = JSON.stringify({ ...game(2), result: '*' })
  await store.write(game(3))
  expect((await store.list()).length).toBe(1)

  let error: unknown = null
  try {
    await store.write({ ...game(4), moves: ['e2e9'] })
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(Error)
  expect(await createOfflineStore(memoryHost(), DATA).list()).toEqual([])
})

test('upload sends unsynced games in batches of 50, records results, and never re-sends', async () => {
  const batches: string[][] = []
  const answer = (req: Sent) => {
    const games = (req.body as { games: OfflineGame[] }).games
    batches.push(games.map(g => g.clientId))
    const results: ImportResult[] = games.map((g, i) => ({
      clientId: g.clientId,
      status: i === 0 ? 'duplicate' : g.engineLevel === 9 ? 'invalid' : 'created',
      gameId: g.engineLevel === 9 ? null : `g_${g.clientId.slice(0, 8)}`,
      ...(g.engineLevel === 9 ? { error: 'illegal move at ply 1' } : {}),
    }))

    return { body: { results } }
  }
  const host = memoryHost({ 'POST /api/mod/offline/import': answer })
  const client = createClient(host, { serverUrl: SERVER, clientId: CLIENT_ID, token: () => 't' })
  const store = createOfflineStore(host, DATA)
  for (let i = 1; i <= 60; i++) await store.write(game(i, i === 7 ? { engineLevel: 9 } : {}))

  const first = await store.uploadPending(client)
  expect(batches.map(b => b.length)).toEqual([50, 10])
  expect(first).toMatchObject({ sent: 60, created: 57, duplicate: 2, invalid: 1, pending: 0, error: null })
  const kept = host.kept['offline.uploaded'] as Record<string, { status: string; gameId: string | null }>
  expect(Object.keys(kept).length).toBe(60)
  expect(kept[game(7).clientId]).toMatchObject({ status: 'invalid', gameId: null })
  expect(host.last()?.headers.Authorization).toBe('Bearer t')

  // Files are untouched; a second run sends nothing.
  const second = await store.uploadPending(client)
  expect(second.sent).toBe(0)
  expect(batches.length).toBe(2)

  // A new game goes up alone.
  await store.write(game(61))
  await store.uploadPending(client)
  expect(batches[2]).toEqual([game(61).clientId])
})

test('a failed batch keeps its games for later', async () => {
  let isDown = true
  const host = memoryHost({
    'POST /api/mod/offline/import': req =>
      isDown
        ? { status: 503, body: { error: 'unavailable', message: 'maintenance' } }
        : {
            body: {
              results: (req.body as { games: OfflineGame[] }).games.map(g => ({ clientId: g.clientId, status: 'created', gameId: 'g' })),
            },
          },
  })
  const client = createClient(host, { serverUrl: SERVER, clientId: CLIENT_ID, token: () => 't' })
  const store = createOfflineStore(host, DATA)
  await store.write(game(1))
  await store.write(game(2))

  const failed = await store.uploadPending(client)
  expect(failed).toMatchObject({ sent: 0, pending: 2, error: 'maintenance' })
  expect(host.kept['offline.uploaded']).toBeUndefined()

  isDown = false
  expect((await store.uploadPending(client)).created).toBe(2)
})

test('data folder: setting, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  expect(resolveDataDir(' D:\\games\\ ', {})).toBe('D:/games')
  expect(resolveDataDir('', { configDir: 'C:\\Users\\luc\\.claude', home: 'C:\\Users\\luc' })).toBe('C:/Users/luc/.claude/terminal-games')
  expect(resolveDataDir('', { home: '/home/luc' })).toBe('/home/luc/.claude/terminal-games')
})
