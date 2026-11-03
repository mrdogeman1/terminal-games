// terminal-games: the values the mod keeps in $.state (its contract). The
// Client view's props are in hooks/view-types.ts, the online mirror's types
// in hooks/online/reducer.ts.

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
  online: { games: number; offersIn: number; offersOut: number; isQueued: boolean }
  // Bumped when anything else the pane draws changed (the online lobby,
  // a running clock): reading the atom redraws the pane.
  rev: number
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-games': {
      net: Shaped<NetView>
    }
  }
}
