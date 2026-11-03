import type { FsEntry, HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult, Timer } from 'claude-code'

// The part of `$` the mod's logic uses. The engine's `$` fits it as is; tests
// hand in an adapter over the test kit's `$` (tests/kit.ts), so every call
// still goes through the engine and the test's `on(...)` fakes answer it.
export type Host = {
  http: { fetch: (url: string, init?: HttpInit) => Promise<HttpResponse> }
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
  }
  clock: {
    now: () => Promise<number>
    after: (ms: number, fn: () => void) => Timer
    every: (ms: number, fn: () => void) => Timer
  }
  fs: {
    read: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
    list: (path?: string) => Promise<FsEntry[]>
    exists: (path: string) => Promise<boolean>
  }
  process: { run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult> }
}

// $.store keys (PROTOCOL.md 1, 4.3, 13.5, 16.3).
export const STORE = {
  clientId: 'clientInstanceId',
  auth: 'auth',
  eventsSeq: 'events.seq',
  uploaded: 'offline.uploaded',
} as const

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const isUuidV4 = (s: unknown): s is string => typeof s === 'string' && UUID_V4.test(s)

export const uuidV4 = (): string => {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// The install's client id (PROTOCOL.md 1, X-Client-Id): made once, kept in
// the store, never changed by login or logout.
export async function ensureClientId(host: Pick<Host, 'store'>): Promise<string> {
  const kept = await host.store.get(STORE.clientId)
  if (isUuidV4(kept)) return kept
  const id = uuidV4()
  await host.store.set(STORE.clientId, id)

  return id
}

export const DEFAULT_SERVER = 'http://localhost:3000'

// The configured server, without a trailing slash; empty or not http(s)
// falls back to the local dev server.
export const resolveServerUrl = (setting: unknown): string => {
  const raw = typeof setting === 'string' ? setting.trim() : ''
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) return DEFAULT_SERVER

  return raw.replace(/\/+$/, '')
}
