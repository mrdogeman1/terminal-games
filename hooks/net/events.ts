import type { Timer } from 'claude-code'

import { STORE } from '../host'
import type { Host } from '../host'
import { ApiError, UpgradeRequiredError } from './client'
import type { ModClient } from './client'
import type { GameEventEnvelope } from './protocol'

export type EventLoopOptions = {
  // New events, ascending by seq, each seq > the last one delivered, with
  // the response's serverTime.
  onEvents: (events: GameEventEnvelope[], serverTime: number | null) => void | Promise<void>
  // 410 events_expired: refetch /me, games, offers, friends, threads (14.4). The loop
  // continues from `seq` afterwards.
  onResync: (seq: number) => void | Promise<void>
  // Called when the loop stops by itself (401, 426).
  onStop?: (reason: 'unauthorized' | 'upgrade') => void
  tickMs?: number
  timeoutMs?: number
  // How long past timeoutMs a request may stay unanswered before the loop
  // treats it as stuck and starts a newer one (newest request wins, 2.3).
  stuckGraceMs?: number
}

export type EventLoopStatus = {
  isRunning: boolean
  since: number | undefined
  isInFlight: boolean
  failures: number
  backoffUntil: number
}

const MAX_BACKOFF = 30_000

// The long-poll of PROTOCOL.md 14.5: one GET /api/mod/events in flight per
// install, the next started by a `$.clock.every` tick as soon as the last one
// returned; `since` is always the server's `seq`, kept in the store under
// "events.seq". A response from a request that was superseded (by `stop`, a
// restart, or a stuck request replaced) is dropped: the newer request reads
// the same events again from the same `since`.
export function createEventLoop(
  host: Pick<Host, 'clock' | 'store'>,
  client: Pick<ModClient, 'events'>,
  options: EventLoopOptions,
) {
  const tickMs = options.tickMs ?? 500
  const timeoutMs = options.timeoutMs ?? 20_000
  const stuckMs = timeoutMs + (options.stuckGraceMs ?? 15_000)

  let since: number | undefined
  let generation = 0
  let inFlight: { gen: number; startedAt: number } | null = null
  let failures = 0
  let backoffUntil = 0
  let running = false
  let timer: Timer | null = null

  const persist = async (seq: number) => {
    since = seq
    await host.store.set(STORE.eventsSeq, seq).catch(() => undefined)
  }

  const stop = (reason?: 'unauthorized' | 'upgrade') => {
    running = false
    generation++
    inFlight = null
    timer?.cancel()
    timer = null
    if (reason) options.onStop?.(reason)
  }

  const fail = async (error: unknown) => {
    if (error instanceof UpgradeRequiredError) return stop('upgrade')
    if (error instanceof ApiError && error.status === 401) return stop('unauthorized')
    if (error instanceof ApiError && error.status === 410) {
      const seq = typeof error.body?.seq === 'number' ? error.body.seq : undefined
      failures = 0
      if (seq !== undefined) await persist(seq)
      await options.onResync(seq ?? since ?? 0)

      return
    }
    const now = await host.clock.now()
    if (error instanceof ApiError && (error.status === 429 || error.status === 503)) {
      backoffUntil = now + (error.retryAfterMs ?? 5_000)

      return
    }
    // Network errors, 5xx and anything unexpected: 2 s, 4 s, 8 s ... 30 s.
    failures++
    backoffUntil = now + Math.min(MAX_BACKOFF, 2_000 * 2 ** (failures - 1))
  }

  // One step: starts a request unless one is in flight (and not stuck) or
  // the loop is backing off. Resolves when that request was handled.
  async function tick(): Promise<void> {
    if (!running) return
    const now = await host.clock.now()
    if (inFlight && now - inFlight.startedAt < stuckMs) return
    if (now < backoffUntil) return

    const gen = ++generation
    inFlight = { gen, startedAt: now }
    let res
    try {
      res = await client.events(since, timeoutMs)
    } catch (error) {
      if (gen !== generation) return
      inFlight = null
      await fail(error)

      return
    }
    if (gen !== generation) return
    inFlight = null
    failures = 0

    const after = since
    const fresh = (res.events ?? []).filter(e => after === undefined || e.seq > after)
    if (fresh.length) await options.onEvents(fresh, typeof res.serverTime === 'number' ? res.serverTime : null)
    if (typeof res.seq === 'number') await persist(res.seq)
    if (res.more && running) await tick()
  }

  return {
    // Starts polling from the stored seq, else from `fallbackSeq` (me.eventSeq).
    async start(fallbackSeq?: number) {
      if (running) stop()
      const kept = await host.store.get(STORE.eventsSeq)
      since = typeof kept === 'number' && Number.isSafeInteger(kept) ? kept : fallbackSeq
      running = true
      failures = 0
      backoffUntil = 0
      timer = host.clock.every(tickMs, () => void tick())
      void tick()
    },
    stop: () => stop(),
    tick,
    // Forget the stored seq (logout, other server).
    async reset() {
      stop()
      since = undefined
      await host.store.delete(STORE.eventsSeq).catch(() => undefined)
    },
    status: (): EventLoopStatus => ({
      isRunning: running,
      since,
      isInFlight: inFlight !== null,
      failures,
      backoffUntil,
    }),
  }
}

export type EventLoop = ReturnType<typeof createEventLoop>
