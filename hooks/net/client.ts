import type { HttpResponse } from 'claude-code'

import type { Host } from '../host'
import type {
  BlocksResponse,
  ChatMessageInfo,
  ChatThreadInfo,
  CreateGameRequest,
  DrawAction,
  EventsResponse,
  FriendEntry,
  FriendRequestResponse,
  FriendsResponse,
  GameState,
  GameStatus,
  GamesListResponse,
  ImportResponse,
  LobbyEntry,
  LobbyOfferRequest,
  LobbyResponse,
  LogoutResponse,
  MeResponse,
  MessagesResponse,
  MoveRequest,
  MoveResponse,
  Offer,
  OffersResponse,
  OfflineGame,
  QueueJoinRequest,
  QueueLeaveResponse,
  ThreadsResponse,
  VersionResponse,
} from './protocol'

// Kept in step with .claude-plugin/plugin.json (a test checks it).
export const MOD_VERSION = '0.1.0'

// A non-2xx answer from /api/mod/* (PROTOCOL.md 2.1). `code` is the
// envelope's `error`; an unknown code is read by its status class.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// 426: the mod is too old. Once seen, the client stops all online traffic.
export class UpgradeRequiredError extends ApiError {
  constructor(readonly minVersion: string | null, message: string, body: Record<string, unknown> | null) {
    super(426, 'upgrade_required', message, body)
    this.name = 'UpgradeRequiredError'
  }
}

// fetch threw, or answered status 0: back off and retry (2.2).
export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

export type ClientOptions = {
  serverUrl: string
  clientId: string
  modVersion?: string
  // The bearer token now, read on every request (it can rotate).
  token?: () => string | undefined
  // 401 on an authenticated call: the session is gone (4.4).
  onUnauthorized?: () => void
  // 426 from any call, or /version naming a minimum above ours (3).
  onUpgradeRequired?: (error: UpgradeRequiredError) => void
  // A `set-auth-token` response header (4.4): replace the stored token.
  onTokenRotated?: (token: string) => void
}

type Query = Record<string, string | number | undefined>
type Call = { auth?: boolean; query?: Query; body?: unknown }

const qs = (query: Query | undefined) => {
  const parts = Object.entries(query ?? {})
    .filter((kv): kv is [string, string | number] => kv[1] !== undefined && kv[1] !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)

  return parts.length ? `?${parts.join('&')}` : ''
}

const parseJson = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

// Retry-After from the body (ms) or the header (seconds).
const retryAfter = (res: HttpResponse, body: Record<string, unknown> | null): number | null => {
  if (typeof body?.retryAfterMs === 'number') return body.retryAfterMs
  const header = Number(res.headers['retry-after'])

  return Number.isFinite(header) && header >= 0 ? header * 1000 : null
}

// semver compare of "x.y.z" (pre-release tags ignored): -1, 0 or 1.
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }

  return 0
}

const enc = encodeURIComponent

// The typed client for every /api/mod/* endpoint of PROTOCOL.md (20). Every
// request carries X-Mod-Version and X-Client-Id; all but /version the bearer
// token. Each call resolves the parsed body or rejects an ApiError,
// UpgradeRequiredError or NetworkError.
export function createClient(host: Pick<Host, 'http'>, options: ClientOptions) {
  const base = options.serverUrl.replace(/\/+$/, '')
  const version = options.modVersion ?? MOD_VERSION
  let upgrade: UpgradeRequiredError | null = null

  const headersFor = (call: Call): Record<string, string> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Mod-Version': version,
      'X-Client-Id': options.clientId,
    }
    if (call.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'
    if (call.auth !== false) {
      const token = options.token?.()
      if (token) headers.Authorization = `Bearer ${token}`
    }

    return headers
  }

  const markUpgrade = (error: UpgradeRequiredError) => {
    if (upgrade) return
    upgrade = error
    options.onUpgradeRequired?.(error)
  }

  async function request<T>(method: string, path: string, call: Call = {}): Promise<T> {
    if (upgrade) throw upgrade
    let res: HttpResponse
    try {
      res = await host.http.fetch(`${base}${path}${qs(call.query)}`, {
        method,
        headers: headersFor(call),
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      })
    } catch (error) {
      throw new NetworkError(error instanceof Error ? error.message : String(error))
    }
    if (res.status === 0) throw new NetworkError('no response')

    const rotated = res.headers['set-auth-token']
    if (rotated && call.auth !== false) options.onTokenRotated?.(rotated)

    const parsed = parseJson(res.text)
    if (res.ok) return parsed as T

    const body = asRecord(parsed)
    const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`
    if (res.status === 426) {
      const error = new UpgradeRequiredError(
        typeof body?.minVersion === 'string' ? body.minVersion : null,
        message,
        body,
      )
      markUpgrade(error)
      throw error
    }
    if (res.status === 401 && call.auth !== false) options.onUnauthorized?.()

    throw new ApiError(res.status, code, message, body, retryAfter(res, body))
  }

  const get = <T>(path: string, query?: Query) => request<T>('GET', path, { query })
  const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, { body })
  const del = <T>(path: string) => request<T>('DELETE', path)

  return {
    serverUrl: base,
    clientId: options.clientId,
    get isUpgradeRequired() {
      return upgrade !== null
    },
    request,

    // 3
    async version(): Promise<VersionResponse> {
      const v = await request<VersionResponse>('GET', '/api/mod/version', { auth: false })
      if (typeof v?.minModVersion === 'string' && compareVersions(version, v.minModVersion) < 0) {
        const error = new UpgradeRequiredError(v.minModVersion, `Mod ${version} is older than ${v.minModVersion}`, null)
        markUpgrade(error)
        throw error
      }

      return v
    },
    // 4.4
    logout: () => post<LogoutResponse>('/api/mod/logout'),
    // 7
    me: () => get<MeResponse>('/api/mod/me'),
    // 8
    listGames: (q: { status?: GameStatus[]; limit?: number; cursor?: string } = {}) =>
      get<GamesListResponse>('/api/mod/games', {
        status: q.status?.join(','),
        limit: q.limit,
        cursor: q.cursor,
      }),
    // A computer game answers its GameState; a challenge answers an Offer.
    createComputerGame: (req: Extract<CreateGameRequest, { mode: 'computer' }>) =>
      post<GameState>('/api/mod/games', req),
    challenge: (req: Omit<Extract<CreateGameRequest, { mode: 'online' }>, 'mode'>) =>
      post<Offer>('/api/mod/games', { mode: 'online', ...req }),
    getGame: (id: string) => get<GameState>(`/api/mod/games/${enc(id)}`),
    move: (id: string, req: MoveRequest) => post<MoveResponse>(`/api/mod/games/${enc(id)}/move`, req),
    resign: (id: string) => post<GameState>(`/api/mod/games/${enc(id)}/resign`),
    draw: (id: string, action: DrawAction) => post<GameState>(`/api/mod/games/${enc(id)}/draw`, { action }),
    // 9
    lobby: () => get<LobbyResponse>('/api/mod/queue'),
    joinLobby: (req: QueueJoinRequest = {}) => post<LobbyEntry>('/api/mod/queue', req),
    leaveLobby: () => del<QueueLeaveResponse>('/api/mod/queue'),
    sendOffer: (userId: string, req: LobbyOfferRequest) => post<Offer>(`/api/mod/queue/${enc(userId)}/offer`, req),
    offers: () => get<OffersResponse>('/api/mod/offers'),
    acceptOffer: (offerId: string) => post<GameState>(`/api/mod/offers/${enc(offerId)}/accept`),
    // By the receiver: decline. By the sender: cancel.
    declineOffer: (offerId: string) => post<Offer>(`/api/mod/offers/${enc(offerId)}/decline`),
    // 10
    friends: () => get<FriendsResponse>('/api/mod/friends'),
    requestFriend: (username: string) => post<FriendRequestResponse>('/api/mod/friends/request', { username }),
    acceptFriend: (userId: string) => post<{ friend: FriendEntry }>(`/api/mod/friends/${enc(userId)}/accept`),
    removeFriend: (userId: string) => del<{ removed: true }>(`/api/mod/friends/${enc(userId)}`),
    // 11
    chatThreads: (q: { limit?: number; cursor?: string } = {}) =>
      get<ThreadsResponse>('/api/mod/chat/threads', q),
    chatMessages: (threadId: string, q: { before?: string; limit?: number } = {}) =>
      get<MessagesResponse>(`/api/mod/chat/threads/${enc(threadId)}/messages`, q),
    sendChat: (threadId: string, text: string) =>
      post<ChatMessageInfo>(`/api/mod/chat/threads/${enc(threadId)}/messages`, { text }),
    markRead: (threadId: string, upTo?: string) =>
      post<{ unread: number }>(`/api/mod/chat/threads/${enc(threadId)}/read`, upTo ? { upTo } : {}),
    openThread: (username: string) => post<ChatThreadInfo>('/api/mod/chat/dm', { username }),
    // 12
    blocks: () => get<BlocksResponse>('/api/mod/blocks'),
    block: (userId: string) => post<{ blocked: true }>(`/api/mod/blocks/${enc(userId)}`),
    unblock: (userId: string) => del<{ blocked: false }>(`/api/mod/blocks/${enc(userId)}`),
    // 13
    importOffline: (games: readonly OfflineGame[]) =>
      post<ImportResponse>('/api/mod/offline/import', { games }),
    // 14.2
    events: (since: number | undefined, timeoutMs = 20_000) =>
      get<EventsResponse>('/api/mod/events', { since, timeoutMs }),
  }
}

export type ModClient = ReturnType<typeof createClient>
