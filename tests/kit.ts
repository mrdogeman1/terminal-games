import type { HttpInit, HttpResponse, On, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { Host } from '../hooks/host'

// Test helpers (not a test file).
//
// Two layers of fakes:
// - `memoryHost`: an in-memory Host (http routes, store, a manual clock, fs,
//   process) for the logic modules, which take a Host rather than `$`. A test
//   hook cannot itself call `$.http.fetch` and friends (the engine admits only
//   calls a plugin's hooks module spells out), so the modules are unit-tested
//   over this.
// - `fakeServer` / `fakeFs`: the same fakes as hooks beneath the plugins
//   (`on('http.fetch')`, `on('fs.*')`), for tests that drive the real
//   plugin through its command and pane (plugin.test.tsx).

export type Sent = { method: string; url: string; path: string; headers: Record<string, string>; body: unknown }
export type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | 'network-error'
export type Route = (req: Sent) => Reply | Promise<Reply>
export type Routes = Record<string, Route>

const toSent = (url: string, init?: HttpInit): Sent => ({
  method: init?.method ?? 'GET',
  url,
  path: new URL(url).pathname,
  headers: init?.headers ?? {},
  body: init?.body ? JSON.parse(init.body) : undefined,
})

// Answers one request from the routes, keyed "METHOD /path" (no query).
const answer = async (routes: Routes, req: Sent): Promise<HttpResponse | 'network-error'> => {
  const route = routes[`${req.method} ${req.path}`]
  if (!route) return { status: 404, ok: false, headers: {}, text: '{"error":"not_found","message":"no route"}' }
  const reply = await route(req)
  if (reply === 'network-error') return reply
  const status = reply.status ?? 200

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: reply.headers ?? {},
    text: reply.body === undefined ? '' : JSON.stringify(reply.body),
  }
}

export type MemoryHost = Host & {
  sent: Sent[]
  last: () => Sent | undefined
  kept: Record<string, unknown>
  files: Record<string, string>
  runs: { argv: readonly string[]; init?: ProcessRunInit }[]
  // Moves the manual clock, firing due timers in time order and letting
  // the work they start settle.
  advance: (ms: number) => Promise<void>
  settle: () => Promise<void>
  setProcess: (fn: (argv: readonly string[], init?: ProcessRunInit) => ProcessRunResult | Promise<ProcessRunResult>) => void
}

export function memoryHost(routes: Routes = {}, options: { now?: number; store?: Record<string, unknown> } = {}): MemoryHost {
  const sent: Sent[] = []
  const kept: Record<string, unknown> = { ...(options.store ?? {}) }
  const files: Record<string, string> = {}
  const runs: MemoryHost['runs'] = []
  let now = options.now ?? 1_000_000
  let timers: { id: number; due: number; fn: () => void; every?: number }[] = []
  let nextId = 1
  let process: Parameters<MemoryHost['setProcess']>[0] = () => {
    throw new Error('no process')
  }

  const settle = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
  }
  const add = (ms: number, fn: () => void, every?: number) => {
    const id = nextId++
    timers.push({ id, due: now + Math.max(0, ms), fn, every })

    return { cancel: () => void (timers = timers.filter(t => t.id !== id)) }
  }

  return {
    sent,
    last: () => sent[sent.length - 1],
    kept,
    files,
    runs,
    http: {
      fetch: async (url, init) => {
        const req = toSent(url, init)
        sent.push(req)
        const res = await answer(routes, req)
        if (res === 'network-error') throw new Error('network down')

        return res
      },
    },
    store: {
      get: async key => (key in kept ? JSON.parse(JSON.stringify(kept[key])) : undefined),
      set: async (key, value) => void (kept[key] = JSON.parse(JSON.stringify(value))),
      delete: async key => void delete kept[key],
    },
    clock: {
      now: async () => now,
      after: (ms, fn) => add(ms, fn),
      every: (ms, fn) => add(ms, fn, Math.max(1, ms)),
    },
    fs: {
      read: async path => {
        if (!(path in files)) throw new Error(`ENOENT ${path}`)
        return files[path]!
      },
      write: async (path, text) => void (files[path] = text),
      exists: async path => path in files || Object.keys(files).some(p => p.startsWith(`${path}/`)),
      list: async (path = '.') => {
        const prefix = `${path.replace(/\/+$/, '')}/`
        const names = new Set(
          Object.keys(files)
            .filter(p => p.startsWith(prefix))
            .map(p => p.slice(prefix.length).split('/')[0]!),
        )

        return [...names].map(name => ({
          name,
          kind: `${prefix}${name}` in files ? ('file' as const) : ('dir' as const),
          size: files[`${prefix}${name}`]?.length ?? 0,
          mtimeMs: 0,
          isLink: false,
        }))
      },
    },
    process: {
      run: async (argv, init) => {
        runs.push({ argv, init })
        return process(argv, init)
      },
    },
    setProcess: fn => void (process = fn),
    settle,
    advance: async (ms: number) => {
      const end = now + ms
      await settle()
      for (;;) {
        const due = timers.filter(t => t.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0]
        if (!due) break
        now = Math.max(now, due.due)
        if (due.every) due.due += due.every
        else timers = timers.filter(t => t.id !== due.id)
        due.fn()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

// The same routes as a hook beneath the plugins, for tests of the plugin.
export function fakeServer(on: On, routes: Routes) {
  const sent: Sent[] = []
  on('http.fetch', async (_$, e: { url: string; init?: HttpInit }) => {
    const req = toSent(e.url, e.init)
    sent.push(req)
    const res = await answer(routes, req)
    if (res === 'network-error') return { deny: 'network down' }

    return { value: res }
  })

  return { sent, last: () => sent[sent.length - 1] }
}

// What a promise rejected with, or null when it resolved.
export const rejection = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p
  } catch (error) {
    return error
  }
  return null
}

export const CLIENT_ID = '0b6c2a8e-6f0d-4f57-a4a5-2b1f7c9d3e10'
export const SERVER = 'https://games.example.com'
