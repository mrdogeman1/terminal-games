import type { NetView } from '../types'
import { movetext } from './games/chess'
import { uuidV4 } from './host'
import type { OfflineGame, OfflineReason } from './net/protocol'
import { offlinePgn } from './offline/store'
import { cycleMark, stepRange, toJoinRequest } from './online/queue-form'
import { btn, emptyUi, offerTimeControl, onlineView, seg } from './online/ui'
import type { UiState } from './online/ui'
import type { Session } from './session'
import type { ViewProps, ViewRow } from './view-types'

// The pane's logic without the engine: the account rows, the online rows
// and the actions the view posts, run against the session. register.tsx
// wires it to `$`; tests and the end-to-end driver use it as is.

// The account rows at the top of the pane.
export const topRows = (v: NetView): ViewRow[] => {
  const who =
    v.phase === 'signed-in'
      ? `Signed in as ${v.username ?? '?'}${v.rating !== null ? ` (${v.rating})` : ''}`
      : v.phase === 'signing-in'
        ? 'Signing in...'
        : v.phase === 'upgrade'
          ? 'Update needed'
          : v.phase === 'unreachable'
            ? 'Offline (server not reachable)'
            : v.phase === 'starting'
              ? 'Starting...'
              : 'Offline: /games login to play online'
  const rows: ViewRow[] = []
  const first = [seg('GAMES ', { b: true }), seg(who, { dim: v.phase !== 'signed-in' })]
  if (v.phase === 'signed-out' || v.phase === 'unreachable') first.push(seg(' '), btn('login', 'login'))
  rows.push({ segs: first })
  if (v.login) {
    rows.push({ segs: [seg('Approve code '), seg(v.login.userCode, { b: true, c: 'claude' }), seg(' in your browser ')] })
    rows.push({
      segs: [seg(v.login.uriComplete, { dim: true }), ...(v.login.canOpen ? [seg(' '), btn('open', 'open-login')] : [])],
    })
  }
  if (v.message) rows.push({ segs: [seg(v.message, { c: 'warning' })] })
  const counts: string[] = []
  if (v.phase === 'signed-in') {
    counts.push(`Online games ${v.online.games}`)
    if (v.online.offersIn) counts.push(`offers ${v.online.offersIn}`)
    if (v.online.isQueued) counts.push('in the queue')
  }
  counts.push(`Offline games ${v.offline.files}${v.offline.pending ? ` (${v.offline.pending} not uploaded)` : ''}`)
  rows.push({ segs: [seg(counts.join(' · '), { dim: true })] })

  return rows
}

const REASON: Record<string, OfflineReason> = {
  checkmate: 'checkmate',
  stalemate: 'stalemate',
  'only kings left': 'insufficient_material',
  'move limit': 'max_plies',
}
const RESULT = { w: '1-0', b: '0-1', draw: '1/2-1/2' } as const

// A finished offline game as the view reported it, as the protocol's file.
export const offlineGameOf = (raw: unknown, now: number): OfflineGame | null => {
  const r = raw as Record<string, unknown> | null
  if (!r || !Array.isArray(r.moves) || !Array.isArray(r.sans)) return null
  const moves = r.moves.filter((m): m is string => typeof m === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))
  const sans = r.sans.filter((m): m is string => typeof m === 'string' && m.length <= 10)
  if (moves.length === 0 || moves.length !== r.moves.length || sans.length !== moves.length || moves.length > 1000) return null
  const result = RESULT[r.result as keyof typeof RESULT]
  const reason = REASON[String(r.reason)]
  const level = r.level
  if (!result || !reason || typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 10) return null
  const color = r.you === 'b' ? 'black' : 'white'
  const head = { clientId: uuidV4(), playedAt: new Date(now).toISOString(), color, engineLevel: level, result } as const

  return { ...head, reason, pgn: offlinePgn(head, movetext(sans)), moves }
}

type Act = { v: string; n: number; id: string; [k: string]: unknown }

const readActs = (data: unknown): Act[] => {
  const acts = (data as { acts?: unknown } | null)?.acts
  if (!Array.isArray(acts)) return []
  return acts.filter(
    (a): a is Act =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as Act).v === 'string' &&
      typeof (a as Act).n === 'number' &&
      typeof (a as Act).id === 'string' &&
      (a as Act).id.length <= 100,
  )
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createPane(getSession: () => Session | null) {
  let ui: UiState = emptyUi()
  // The actions done, per view instance: the highest n seen.
  const seen = new Map<string, number>()

    const refreshLobby = async () => {
      const s = getSession()
      if (!s?.auth()) return
      const [lobby, friends] = await Promise.all([
        s.actions.lobby().catch(() => null),
        s.actions.friends().catch(() => null),
      ])
      ui = { ...ui, lobby: lobby ?? ui.lobby, friends: friends ?? ui.friends }
    }

    // One action from the view; its outcome lands in `ui.note`.
    const doAct = async (a: Act, now: number) => {
      const s = getSession()
      if (!s) return
      const id = a.id
      const [verb, arg = ''] = [id.split(':')[0]!, id.slice(id.indexOf(':') + 1)]
      const game = ui.gameId
      try {
        if (id === 'login') return void (await s.login())
        if (id === 'open-login') return void (await s.openLoginUrl())
        if (id === 'mode:online') {
          ui = { ...ui, mode: 'online', note: null }
          return refreshLobby()
        }
        if (id === 'mode:offline') return void (ui = { ...ui, mode: 'offline' })
        if (id === 'offline') {
          const record = offlineGameOf(a.game, now)
          if (record) await s.saveOffline(record)
          return
        }
        ui = { ...ui, note: null }
        if (id === 'refresh' || id === 'back') {
          ui = { ...ui, gameId: id === 'back' ? null : ui.gameId }
          return refreshLobby()
        }
        if (verb === 'form') {
          const [dim, n] = arg.split(':')
          const i = Number(n)
          if (dim === 'clock') ui = { ...ui, form: cycleMark(ui.form, 'gameClocks', i) }
          if (dim === 'pm') ui = { ...ui, form: cycleMark(ui.form, 'perMove', i) }
          if (dim === 'range') ui = { ...ui, form: stepRange(ui.form, i < 0 ? -1 : 1) }
          // In the queue, the new wishes replace the old ones.
          if (s.online().queue) {
            const req = toJoinRequest(ui.form, s.online().me?.rating ?? 1200)
            if (!('error' in req)) await s.actions.joinQueue(req)
          }
          return
        }
        if (id === 'queue:join') {
          const req = toJoinRequest(ui.form, s.online().me?.rating ?? 1200)
          if ('error' in req) return void (ui = { ...ui, note: req.error })
          await s.actions.joinQueue(req)
          return refreshLobby()
        }
        if (id === 'queue:leave') {
          await s.actions.leaveQueue()
          return refreshLobby()
        }
        if (verb === 'offer') {
          await s.actions.sendOffer(arg, offerTimeControl(ui.form))
          const who = ui.lobby.find(e => e.userId === arg)?.username ?? 'them'
          return void (ui = { ...ui, note: `Offer sent to ${who}.` })
        }
        if (verb === 'accept') {
          const gameId = await s.actions.acceptOffer(arg)
          return void (ui = { ...ui, gameId })
        }
        if (verb === 'decline') return s.actions.declineOffer(arg)
        if (verb === 'open') {
          ui = { ...ui, gameId: arg }
          return s.actions.openGame(arg)
        }
        if (id === 'move') {
          const uci = typeof a.uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(a.uci) ? a.uci : null
          const gameId = typeof a.game === 'string' ? a.game : null
          if (!uci || !gameId) return
          try {
            await s.actions.move(gameId, uci)
          } finally {
            ui = { ...ui, rev: ui.rev + 1 }
          }
          return
        }
        if (id === 'resign' && game) return s.actions.resign(game)
        if (verb === 'draw' && game && (arg === 'offer' || arg === 'accept' || arg === 'decline')) return s.actions.draw(game, arg)
        if (id === 'chat' && game) {
          const thread = s.online().games[game]?.state.chatThreadId
          const text = typeof a.text === 'string' ? a.text.trim().slice(0, 500) : ''
          if (thread && text) await s.actions.sendChat(thread, text)
          return
        }
        if (id === 'friend') {
          const name = typeof a.text === 'string' ? a.text.trim().slice(0, 40) : ''
          if (!name) return
          const res = await s.actions.requestFriend(name)
          ui = { ...ui, note: res.status === 'accepted' ? `${res.user.username} is now your friend.` : `Friend request sent to ${res.user.username}.` }
          return refreshLobby()
        }
        if (verb === 'friend' && arg.startsWith('accept:')) {
          await s.actions.acceptFriend(arg.slice('accept:'.length))
          return refreshLobby()
        }
      } catch (error) {
        ui = { ...ui, note: errorText(error) }
      }
    }


  return {
    ui: () => ui,
    reset() {
      ui = emptyUi()
      seen.clear()
    },
    refreshLobby,
    doAct,
    // Runs the posted actions not run before; true when there were any.
    async acts(data: unknown, now: number): Promise<boolean> {
      let isAny = false
      for (const a of readActs(data)) {
        if (a.n <= (seen.get(a.v) ?? 0)) continue
        seen.set(a.v, a.n)
        await doAct(a, now)
        isAny = true
      }

      return isAny
    },
    // A game was matched: open it, unless one is open already.
    onMatch(gameId: string) {
      if (!ui.gameId) ui = { ...ui, gameId, mode: 'online' }
      void getSession()?.actions.openGame(gameId).catch(() => undefined)
    },
    // The online rows and board, or null while signed out.
    online(v: NetView, now: number, cols: number): ViewProps['online'] {
      const s = getSession()
      return s && v.phase === 'signed-in' ? onlineView(ui, s.online(), now, cols) : null
    },
  }
}

export type Pane = ReturnType<typeof createPane>
