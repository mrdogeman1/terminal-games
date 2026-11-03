import type { Timer } from 'claude-code'

import { STORE } from '../host'
import type { Host } from '../host'
import { ApiError, createClient, NetworkError } from './client'
import type {
  DeviceCodeResponse,
  DeviceTokenResponse,
  MeResponse,
  OAuthErrorBody,
  StoredAuth,
} from './protocol'

// Device-flow login (PROTOCOL.md 4): the mod shows a code and a URL, the
// person approves in the browser, the mod polls for the token.

export const DEVICE_CLIENT_ID = 'claude-games'
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const post = (host: Pick<Host, 'http'>, url: string, body: unknown) =>
  host.http.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify(body),
  })

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export class DeviceFlowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DeviceFlowError'
  }
}

// 4.1. Rejects DeviceFlowError (an OAuth error or a malformed answer) or the
// fetch's own error.
export async function requestDeviceCode(host: Pick<Host, 'http'>, serverUrl: string): Promise<DeviceCodeResponse> {
  const res = await post(host, `${serverUrl}/api/auth/device/code`, { client_id: DEVICE_CLIENT_ID })
  const body = parse(res.text) as Partial<DeviceCodeResponse & OAuthErrorBody> | null
  if (!res.ok || !body || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    throw new DeviceFlowError(
      body?.error ?? `http_${res.status}`,
      body?.error_description ?? `Could not get a login code (HTTP ${res.status})`,
    )
  }

  return body as DeviceCodeResponse
}

export type TokenPoll =
  | { kind: 'token'; token: DeviceTokenResponse }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
  | { kind: 'retry' } // network error or 5xx: not terminal (4.2)

// 4.2: one poll of the token endpoint, read into what the mod does next.
export async function pollDeviceToken(
  host: Pick<Host, 'http'>,
  serverUrl: string,
  deviceCode: string,
): Promise<TokenPoll> {
  let res
  try {
    res = await post(host, `${serverUrl}/api/auth/device/token`, {
      grant_type: GRANT,
      device_code: deviceCode,
      client_id: DEVICE_CLIENT_ID,
    })
  } catch {
    return { kind: 'retry' }
  }
  if (res.status === 0 || res.status >= 500) return { kind: 'retry' }
  const body = parse(res.text) as Partial<DeviceTokenResponse & OAuthErrorBody> | null
  if (res.ok && body && typeof body.access_token === 'string' && body.access_token) {
    return { kind: 'token', token: body as DeviceTokenResponse }
  }
  switch (body?.error) {
    case 'authorization_pending':
      return { kind: 'pending' }
    case 'slow_down':
      return { kind: 'slow_down' }
    case 'access_denied':
      return { kind: 'denied' }
    case 'expired_token':
      return { kind: 'expired' }
    default:
      return { kind: 'error', message: body?.error_description ?? body?.error ?? `HTTP ${res.status}` }
  }
}

export type DeviceLoginEnd =
  | { kind: 'signed-in'; auth: StoredAuth; me: MeResponse }
  | { kind: 'denied' | 'expired' | 'error' | 'cancelled'; message: string }

export type DeviceLoginOptions = {
  serverUrl: string
  clientId: string
  // Called once the code is known: show user_code and the URL (4.1).
  onCode: (code: DeviceCodeResponse) => void
  // Called once, with how it ended.
  onEnd: (end: DeviceLoginEnd) => void | Promise<void>
}

export type DeviceLogin = { code: DeviceCodeResponse; cancel: () => void }

// Runs the whole flow: code, polling at the server's interval (+5 s on
// slow_down), then GET /me with the new token and `auth` stored (4.3).
// Resolves once the code is shown; the polling runs on `$.clock.after`.
export async function startDeviceLogin(
  host: Pick<Host, 'http' | 'clock' | 'store'>,
  options: DeviceLoginOptions,
): Promise<DeviceLogin> {
  const code = await requestDeviceCode(host, options.serverUrl)
  options.onCode(code)

  const deadline = (await host.clock.now()) + Math.max(1, code.expires_in) * 1000
  let intervalMs = Math.max(1, code.interval || 5) * 1000
  let timer: Timer | null = null
  let isOver = false

  const end = async (result: DeviceLoginEnd) => {
    if (isOver) return
    isOver = true
    timer?.cancel()
    await options.onEnd(result)
  }

  const finish = async (token: string) => {
    const client = createClient(host, {
      serverUrl: options.serverUrl,
      clientId: options.clientId,
      token: () => token,
    })
    let me: MeResponse
    try {
      me = await client.me()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'username_required') {
        const url = typeof error.body?.url === 'string' ? ` at ${error.body.url}` : ''
        return end({ kind: 'error', message: `Pick a username on the website first${url}, then run /games login again.` })
      }
      const message = error instanceof NetworkError ? 'Server not reachable' : (error as Error).message

      return end({ kind: 'error', message: `Login check failed: ${message}` })
    }
    const auth: StoredAuth = {
      serverUrl: options.serverUrl,
      token,
      userId: me.user.id,
      username: me.user.username,
      obtainedAt: new Date(await host.clock.now()).toISOString(),
    }
    await host.store.set(STORE.auth, auth)
    await end({ kind: 'signed-in', auth, me })
  }

  const step = async () => {
    if (isOver) return
    if ((await host.clock.now()) >= deadline) {
      return end({ kind: 'expired', message: 'Code expired, run /games login again.' })
    }
    const poll = await pollDeviceToken(host, options.serverUrl, code.device_code)
    if (isOver) return
    switch (poll.kind) {
      case 'token':
        return finish(poll.token.access_token)
      case 'denied':
        return end({ kind: 'denied', message: 'Login denied.' })
      case 'expired':
        return end({ kind: 'expired', message: 'Code expired, run /games login again.' })
      case 'error':
        return end({ kind: 'error', message: `Login failed: ${poll.message}. Run /games login to try again.` })
      case 'slow_down':
        intervalMs += 5_000
        break
      case 'pending':
      case 'retry':
        break
    }
    schedule()
  }

  const schedule = () => {
    timer = host.clock.after(intervalMs, () => void step())
  }
  schedule()

  return {
    code,
    cancel: () => void end({ kind: 'cancelled', message: 'Login cancelled.' }),
  }
}

// 4.1: open the verification URL only when it is https (or http on
// localhost) and on the configured server's origin.
export const isSafeVerificationUrl = (url: string, serverUrl: string): boolean => {
  try {
    const u = new URL(url)
    const s = new URL(serverUrl)
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    const isSchemeOk = u.protocol === 'https:' || (u.protocol === 'http:' && isLocal)

    return isSchemeOk && u.origin === s.origin
  } catch {
    return false
  }
}

// The argv that opens a URL in the default browser, the URL one argument
// and never through a shell's parsing. On Windows rundll32 instead of
// `cmd /c start` (cmd would read & and ^ in a query string).
export const openUrlArgv = (url: string, platform: 'windows' | 'mac' | 'linux'): string[] =>
  platform === 'windows'
    ? ['rundll32', 'url.dll,FileProtocolHandler', url]
    : platform === 'mac'
      ? ['open', url]
      : ['xdg-open', url]
