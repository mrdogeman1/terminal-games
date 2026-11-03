// terminal-games (placeholder name, see README): the values the mod keeps in $.state (its contract). The
// online mirror's own types live in hooks/online/reducer.ts; here it is kept
// as plain JSON data.

export type NetPhase = 'starting' | 'signed-out' | 'signing-in' | 'signed-in' | 'unreachable' | 'upgrade'

export type LoginPrompt = {
  userCode: string
  uri: string
  uriComplete: string
  // The URL passed the origin check (PROTOCOL.md 4.1) and may be opened.
  canOpen: boolean
  expiresAt: number
}

export type NetView = {
  phase: NetPhase
  serverUrl: string
  username: string | null
  rating: number | null
  login: LoginPrompt | null
  message: string | null
  offline: { files: number; pending: number }
  online: { games: number; challenges: number; offers: number; isQueued: boolean }
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-games': {
      net: Shaped<NetView>
    }
  }
}
