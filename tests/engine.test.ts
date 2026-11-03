import { expect, test } from 'claude-code/testing'

import { chainEngines, noFallback } from '../hooks/engine/engine'
import type { FallbackEngine } from '../hooks/engine/engine'
import { createStockfishEngine, parseBestMove, stockfishInput } from '../hooks/engine/stockfish'
import { memoryHost } from './kit'

const START = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const DIR = 'C:/mods/terminal-games/stockfish'

const builtIn: FallbackEngine = { name: 'built-in', isBuiltIn: true, bestMove: async () => 'e7e5' }

test('Stockfish runs once per move with the position and level on its input', async () => {
  const host = memoryHost()
  host.files[`${DIR}/stockfish.exe`] = 'binary'
  host.setProcess(() => ({ exitCode: 0, stdout: 'info depth 1\nbestmove c7c5 ponder g1f3\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))
  const sf = createStockfishEngine(host, DIR)

  expect(await sf.isAvailable()).toBe(true)
  expect(await sf.bestMove({ fen: START, level: 10 })).toBe('c7c5')
  expect(host.runs.length).toBe(1)
  expect(host.runs[0]?.argv).toEqual([`${DIR}/stockfish.exe`])
  expect(host.runs[0]?.init).toMatchObject({ cwd: DIR, timeoutMs: 15_000 })
  expect(host.runs[0]?.init?.stdin).toBe(stockfishInput({ fen: START, level: 10 }))
  expect(stockfishInput({ fen: START, level: 1 })).toBe(
    `uci\nsetoption name Skill Level value 0\nucinewgame\nposition fen ${START}\ngo depth 1\nsetoption name Skill Level value 0\n`,
  )
  expect(parseBestMove('bestmove a7a8n\n')).toBe('a7a8n')
  expect(parseBestMove('bestmove (none)\n')).toBeNull()
})

test('missing, failing or silent Stockfish falls back to the built-in engine', async () => {
  const host = memoryHost()
  const engine = chainEngines(createStockfishEngine(host, DIR), builtIn)
  expect(await engine.move({ fen: START, level: 3 })).toEqual({ move: 'e7e5', by: 'built-in' })
  expect(host.runs.length).toBe(0)

  host.files[`${DIR}/stockfish`] = 'binary'
  host.setProcess(() => {
    throw new Error('timed out')
  })
  expect(await engine.move({ fen: START, level: 3 })).toEqual({ move: 'e7e5', by: 'built-in' })
  expect(host.runs[0]?.argv).toEqual([`${DIR}/stockfish`])

  host.setProcess(() => ({ exitCode: 0, stdout: 'bestmove g8f6\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))
  expect(await engine.move({ fen: START, level: 3 })).toEqual({ move: 'g8f6', by: 'stockfish' })
})

test('bad requests reach no engine; no fallback yet answers nothing', async () => {
  const host = memoryHost()
  host.files[`${DIR}/stockfish.exe`] = 'binary'
  const engine = chainEngines(createStockfishEngine(host, DIR), noFallback)
  expect(await engine.move({ fen: 'not a fen', level: 3 })).toEqual({ move: null, by: 'none' })
  expect(await engine.move({ fen: START, level: 11 })).toEqual({ move: null, by: 'none' })
  expect(host.runs.length).toBe(0)
  expect(await chainEngines(noFallback).move({ fen: START, level: 2 })).toEqual({ move: null, by: 'none' })
})
