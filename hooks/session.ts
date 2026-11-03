import type { LoginPrompt, NetView } from '../types'
import { ensureClientId, STORE } from './host'
import type { Host } from './host'
import { ApiError, createClient, NetworkError, UpgradeRequiredError } from './net/client'
import type { ModClient } from './net/client'
import { isSafeVerificationUrl, openUrlArgv, startDeviceLogin } from './net/device'
import type { DeviceLogin } from './net/device'
import { createEventLoop } from './net/events'
import type { EventLoop } from './net/events'
import type {
  DrawAction,
  GameEventEnvelope,
  GameState,
  LobbyEntry,
  LobbySettings,
  MeResponse,
  OfflineGame,
  StoredAuth,
  TimeControl,
} from './net/protocol'
import { createOfflineStore } from './offline/store'
import type { OfflineStore } from './offline/store'
import {
  applyMe,
  applyOffers,
  applySnapshot,
  beginMove,
  emptyOnline,
  failMove,
  incomingOffers,
  markRead,
  outgoingOffers,
  reduceEvents,
  takeFetches,
} from './online/reducer'
import type { OnlineState } from './online/reducer'

// The online session (PROTOCOL.md 17): version check, stored login, device
// login, the event long-poll, the online mirror and the offline upload. The
// pane reads `NetView`; the port's chess view will read `online()`.

export const initialView = (serverUrl: string): NetView => ({
  phase: 'starting',
  serverUrl,
  username: null,
  rating: null,
  login: null,
  message: null,
  offline: { files: 0, pending: 0 },
  online: { games: 0, offersIn: 0, offersOut: 0, isQueued: false },
  rev: 0,
})

export type SessionDeps = {
  host: Host
  serverUrl: string
  dataDir: string
  platform: 'windows' | 'mac' | 'linux'
  setView: (fn: (v: NetView) => NetView) => Promise<void>
  toast: (text: string) => void
  // Called after the online mirror changed (the port redraws the board).
  onOnline?: (state: OnlineState) => void
  // A game was matched (queue, offer or challenge): the pane may open it.
  onMatch?: (gameId: string) => void
}

const readAuth = (v: unknown): StoredAuth | null => {
  const a = v as Partial<StoredAuth> | null
  if (!a || typeof a.token !== 'string' || typeof a.serverUrl !== 'string') return null
  if (typeof a.userId !== 'string' || typeof a.username !== 'string') return null

  return { serverUrl: a.serverUrl, token: a.token, userId: a.userId, username: a.username, obtainedAt: String(a.obtainedAt ?? '') }
}

export function createSession(deps: SessionDeps) {
  const { host, serverUrl } = deps
  let clientId = ''
  let auth: StoredAuth | null = null
  let client: ModClient | null = null
  let loop: EventLoop | null = null
  let login: DeviceLogin | null = null
  let prompt: LoginPrompt | null = null
  let online: OnlineState = emptyOnline()
  const offline: OfflineStore = createOfflineStore(host, deps.dataDir)

  const setOnline = async (next: OnlineState) => {
    online = next
    deps.onOnline?.(online)
    await deps.setView(v => ({
      ...v,
      rating: online.me?.rating ?? v.rating,
      online: {
        games: Object.values(online.games).filter(g => g.state.status === 'active').length,
        offersIn: incomingOffers(online).length,
        offersOut: outgoingOffers(online).length,
        isQueued: online.queue !== null,
      },
    }))
  }

  const signedOut = async (message: string | null) => {
    loop?.stop()
    auth = null
    await host.store.delete(STORE.auth).catch(() => undefined)
    online = emptyOnline()
    await deps.setView(v => ({ ...initialView(serverUrl), phase: 'signed-out', message, offline: v.offline }))
  }

  const api = (): ModClient => {
    if (client) return client
    client = createClient(host, {
      serverUrl,
      clientId,
      token: () => auth?.token,
      onUnauthorized: () => {
        if (auth) void signedOut('Signed out: the session ended. Run /games login.')
      },
      onUpgradeRequired: error => {
        loop?.stop()
        void deps.setView(v => ({
          ...v,
          phase: 'upgrade',
          message: `This mod is too old for the server${error.minVersion ? ` (needs ${error.minVersion})` : ''}. Run /plugin update terminal-games.`,
        }))
      },
      onTokenRotated: token => {
        if (!auth) return
        auth = { ...auth, token }
        void host.store.set(STORE.auth, auth)
      },
    })

    return client
  }

  // GET each game the mirror asked for and fold it in.
  const fetchGames = async () => {
    const [ids, rest] = takeFetches(online)
    if (!ids.length) return
    online = rest
    let next = online
    for (const id of ids) {
      try {
        const game = await api().getGame(id)
        next = applySnapshot(next, game, await host.clock.now())
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) continue
        next = { ...next, toFetch: [...next.toFetch, id] }
      }
    }
    await setOnline(next)
  }

  const fetchOffers = async () => {
    const o = await api().offers().catch(() => null)
    if (o) await setOnline(applyOffers(online, o.incoming, o.outgoing))
  }

  const onEvents = async (events: GameEventEnvelope[], serverTime: number | null) => {
    const now = await host.clock.now()
    const before = online
    await setOnline(reduceEvents(online, events, now, serverTime))
    for (const e of events) {
      if (e.type === 'match.found') {
        const p = (e as GameEventEnvelope<'match.found'>).payload
        deps.toast(`Match found: you play ${p.color} against ${p.opponent.username} (${p.opponent.rating}).`)
        deps.onMatch?.(p.gameId)
      }
      if (e.type === 'offer.received') {
        const { offer } = (e as GameEventEnvelope<'offer.received'>).payload
        deps.toast(`${offer.from.username} (${offer.from.rating}) offers a game.`)
      }
      if (e.type === 'game.move') {
        const p = (e as GameEventEnvelope<'game.move'>).payload
        const you = before.games[p.gameId]?.state.you
        if (you && p.by !== you) deps.toast(`Your move: they played ${p.move.san}.`)
      }
      if (e.type === 'game.over') {
        const p = (e as GameEventEnvelope<'game.over'>).payload
        const g = online.games[p.gameId]?.state
        if (g) deps.toast(`Game over: ${p.result ?? 'aborted'} (${p.reason.replace(/_/g, ' ')}).`)
      }
      if (e.type === 'game.draw_offer') {
        const p = (e as GameEventEnvelope<'game.draw_offer'>).payload
        if (before.games[p.gameId]?.state.you !== p.by) deps.toast('Your opponent offers a draw.')
      }
      if (e.type === 'chat.message') {
        const { message } = (e as GameEventEnvelope<'chat.message'>).payload
        if (message.kind === 'user' && message.sender && message.sender.userId !== online.me?.userId) {
          deps.toast(`${message.sender.username}: ${message.text.slice(0, 80)}`)
        }
      }
      if (e.type === 'friend.request') {
        const { from } = (e as GameEventEnvelope<'friend.request'>).payload
        deps.toast(`${from.username} wants to be friends.`)
      }
    }
    await fetchGames()
  }

  // An online call; a signed-out session throws.
  const call = <T>(fn: (c: ModClient) => Promise<T>): Promise<T> => {
    if (!auth) return Promise.reject(new Error('Not signed in: /games login'))

    return fn(api())
  }

  const withoutOffer = (id: string) => {
    const offers = { ...online.offers }
    delete offers[id]

    return { ...online, offers }
  }

  const putSnapshot = async (game: GameState) => {
    await setOnline(applySnapshot(online, game, await host.clock.now()))
  }

  // The online actions the pane's lobby and board use. Each rejects with
  // the server's message on failure.
  const actions = {
    async lobby(): Promise<LobbyEntry[]> {
      const res = await call(c => c.lobby())
      await setOnline({ ...online, queue: res.you })

      return res.entries
    },
    async joinQueue(settings: LobbySettings) {
      const entry = await call(c => c.joinLobby(settings))
      await setOnline({ ...online, queue: entry })
    },
    async leaveQueue() {
      await call(c => c.leaveLobby())
      await setOnline({ ...online, queue: null })
    },
    async sendOffer(userId: string, timeControl: TimeControl) {
      const offer = await call(c => c.sendOffer(userId, { timeControl }))
      await setOnline({ ...online, offers: { ...online.offers, [offer.id]: offer } })
    },
    async acceptOffer(id: string): Promise<string> {
      const game = await call(c => c.acceptOffer(id))
      online = withoutOffer(id)
      await putSnapshot(game)
      if (game.chatThreadId) await actions.loadChat(game.chatThreadId).catch(() => undefined)

      return game.id
    },
    async declineOffer(id: string) {
      await call(c => c.declineOffer(id))
      await setOnline(withoutOffer(id))
    },
    async openGame(id: string) {
      const game = await call(c => c.getGame(id))
      await putSnapshot(game)
      if (game.chatThreadId) await actions.loadChat(game.chatThreadId).catch(() => undefined)
    },
    // Shown at once as pending; the answer's game replaces it. A refused
    // move is taken back and the game fetched again.
    async move(id: string, uci: string) {
      const local = online.games[id]
      if (!local) throw new Error('No such game')
      await setOnline(beginMove(online, id, uci))
      try {
        const res = await call(c => c.move(id, { uci, expectedPly: local.state.plyCount }))
        await putSnapshot(res.game)
      } catch (error) {
        await setOnline(failMove(online, id))
        const fresh = await call(c => c.getGame(id)).catch(() => null)
        if (fresh) await putSnapshot(fresh)
        throw error
      }
    },
    async resign(id: string) {
      await putSnapshot(await call(c => c.resign(id)))
    },
    async draw(id: string, action: DrawAction) {
      await putSnapshot(await call(c => c.draw(id, action)))
    },
    async loadChat(threadId: string) {
      const res = await call(c => c.chatMessages(threadId, { limit: 30 }))
      const messages = [...res.messages].sort((a, b) => a.at.localeCompare(b.at))
      await setOnline({ ...online, chat: { ...online.chat, [threadId]: messages } })
      await call(c => c.markRead(threadId)).catch(() => undefined)
      await setOnline(markRead(online, threadId))
    },
    async sendChat(threadId: string, text: string) {
      const message = await call(c => c.sendChat(threadId, text))
      const kept = online.chat[threadId] ?? []
      if (!kept.some(m => m.id === message.id)) {
        await setOnline({ ...online, chat: { ...online.chat, [threadId]: [...kept, message] } })
      }
    },
    friends: () => call(c => c.friends()),
    requestFriend: (username: string) => call(c => c.requestFriend(username)),
    acceptFriend: (userId: string) => call(c => c.acceptFriend(userId)),
  }

  // A finished offline game: written as JSON, uploaded when signed in.
  const saveOffline = async (game: OfflineGame): Promise<string> => {
    const path = await offline.write(game)
    await refreshCounts().catch(() => undefined)
    if (auth) {
      const note = await upload()
      if (note.startsWith('Uploaded')) deps.toast(note)
    }

    return path
  }

  const refreshCounts = async () => {
    const files = await offline.list()
    const done = await offline.uploaded()
    await deps.setView(v => ({
      ...v,
      offline: { files: files.length, pending: files.filter(f => !(f.game.clientId in done)).length },
    }))
  }

  const upload = async (): Promise<string> => {
    if (!auth) return 'Not signed in.'
    const s = await offline.uploadPending(api())
    await refreshCounts()
    if (s.error) return `Offline upload stopped: ${s.error} (${s.pending} left, retried at next login).`
    if (!s.sent) return 'No offline games to upload.'

    return `Uploaded ${s.sent} offline game(s): ${s.created} new, ${s.duplicate} already there, ${s.invalid} rejected.`
  }

  const goOnline = async (me: MeResponse) => {
    await deps.setView(v => ({
      ...v,
      phase: 'signed-in',
      username: me.user.username,
      rating: me.user.rating,
      login: null,
      message: null,
    }))
    await setOnline(applyMe(online, me))
    loop ??= createEventLoop(host, api(), {
      onEvents,
      onResync: async () => {
        const fresh = await api().me()
        let next = applyMe(online, fresh)
        for (const id of Object.keys(next.games)) next = { ...next, toFetch: [...next.toFetch, id] }
        await setOnline(next)
        await fetchGames()
        await fetchOffers()
      },
      onStop: reason => {
        if (reason === 'unauthorized') void signedOut('Signed out: the session ended. Run /games login.')
      },
    })
    await loop.start(me.eventSeq)
    await fetchGames()
    await fetchOffers()
    const note = await upload()
    if (note.startsWith('Uploaded')) deps.toast(note)
  }

  return {
    online: () => online,
    offline,
    actions,
    saveOffline,
    auth: () => auth,
    loop: () => loop,

    // Startup (17.1-3). Never rejects: an unreachable server leaves the mod
    // offline with a message.
    async start() {
      clientId = await ensureClientId(host)
      await refreshCounts().catch(() => undefined)
      auth = readAuth(await host.store.get(STORE.auth))
      if (auth && auth.serverUrl !== serverUrl) {
        // Another server: its token and event seq mean nothing here.
        auth = null
        await host.store.delete(STORE.auth).catch(() => undefined)
        await host.store.delete(STORE.eventsSeq).catch(() => undefined)
      }
      try {
        await api().version()
      } catch (error) {
        if (error instanceof UpgradeRequiredError) return
        await deps.setView(v => ({ ...v, phase: 'unreachable', message: `Server ${serverUrl} not reachable; offline play only.` }))

        return
      }
      if (!auth) return deps.setView(v => ({ ...v, phase: 'signed-out' }))
      try {
        await goOnline(await api().me())
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return
        const message = error instanceof NetworkError ? 'Server not reachable.' : (error as Error).message
        await deps.setView(v => ({ ...v, phase: 'unreachable', message }))
      }
    },

    async login(): Promise<string> {
      if (!clientId) clientId = await ensureClientId(host)
      if (auth) return `Already signed in as ${auth.username}. /games logout first to switch.`
      login?.cancel()
      try {
        login = await startDeviceLogin(host, {
          serverUrl,
          clientId,
          onCode: async code => {
            prompt = {
              userCode: code.user_code,
              uri: code.verification_uri,
              uriComplete: code.verification_uri_complete,
              canOpen: isSafeVerificationUrl(code.verification_uri_complete, serverUrl),
              expiresAt: (await host.clock.now()) + code.expires_in * 1000,
            }
            await deps.setView(v => ({ ...v, phase: 'signing-in', login: prompt, message: null }))
          },
          onEnd: async end => {
            login = null
            prompt = null
            if (end.kind === 'signed-in') {
              auth = end.auth
              deps.toast(`Signed in as ${end.auth.username}.`)
              await goOnline(end.me)

              return
            }
            if (end.kind !== 'cancelled') deps.toast(end.message)
            await deps.setView(v => ({ ...v, phase: 'signed-out', login: null, message: end.message }))
          },
        })
      } catch (error) {
        const message = `Could not start login: ${(error as Error).message}`
        await deps.setView(v => ({ ...v, message }))

        return message
      }
      const c = login.code
      const text = `Open ${c.verification_uri_complete} and approve code ${c.user_code}`
      deps.toast(text)

      return text
    },

    async logout(): Promise<string> {
      login?.cancel()
      if (!auth) {
        await signedOut(null)

        return 'Not signed in.'
      }
      const name = auth.username
      loop?.stop()
      await api().logout().catch(() => undefined)
      await loop?.reset()
      await signedOut(null)

      return `Signed out ${name}.`
    },

    async openLoginUrl(): Promise<string> {
      const url = prompt?.uriComplete
      if (!url) return 'No login in progress.'
      if (!isSafeVerificationUrl(url, serverUrl)) return `Open ${url} by hand.`
      await host.process.run(openUrlArgv(url, deps.platform)).catch(() => undefined)

      return 'Opened the login page.'
    },

    sync: upload,

    status(): string {
      const lines = [`Server: ${serverUrl}`]
      lines.push(auth ? `Signed in as ${auth.username}` : 'Not signed in (offline play only). /games login to play online.')
      const l = loop?.status()
      if (l?.isRunning) lines.push(`Event stream: since ${l.since ?? '-'}${l.failures ? `, ${l.failures} failed tries` : ''}`)
      lines.push(`Offline games folder: ${offline.dir}`)

      return lines.join('\n')
    },

    stop() {
      login?.cancel()
      loop?.stop()
    },
  }
}

export type Session = ReturnType<typeof createSession>
