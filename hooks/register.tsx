import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NetView } from '../types'
import { resolveServerUrl } from './host'
import type { Host } from './host'
import { resolveDataDir } from './offline/store'
import { createSession, initialView } from './session'
import type { Session } from './session'

// terminal-games: the pane, the /games command and the online session. The
// arcade and the chess board come with the port of the agents-panel games;
// until then the pane shows the account and sync state.

const PANE = 'claude-games'
const TITLE = 'Games'

// Bump the tag when NetView's fields change.
const net = atom({ plugin: 'terminal-games', key: 'net' } as const, initialView(''), { shape: 'net-1' })

let session: Session | null = null

const platformOf = async ($: EngineInterface): Promise<'windows' | 'mac' | 'linux'> => {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const home = (await $.env.get('HOME')) ?? ''

  return home.startsWith('/Users/') ? 'mac' : 'linux'
}

const HELP = [
  '/games            open the games pane',
  '/games login      sign in to play online (device code)',
  '/games logout     sign out',
  '/games status     account, server and offline games folder',
  '/games sync       upload offline games now',
].join('\n')

export const register: Register = (on, options) => {
  const serverUrl = resolveServerUrl(options.serverUrl)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'games',
      description: 'Games: open the pane, or login / logout / status / sync',
      argumentHint: '[login|logout|status|sync]',
    })
    session?.stop()
    const dataDir = resolveDataDir(options.dataDir, {
      configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
      home: (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    })
    // The engine's `$` is never handed on as a value: each call is spelled
    // out here, and the logic gets this Host.
    const host: Host = {
      http: { fetch: (url, init) => $.http.fetch(url, init) },
      store: {
        get: key => $.store.get(key),
        set: (key, value) => $.store.set(key, value),
        delete: key => $.store.delete(key),
      },
      clock: {
        now: () => $.clock.now(),
        after: (ms, fn) => $.clock.after(ms, fn),
        every: (ms, fn) => $.clock.every(ms, fn),
      },
      fs: {
        read: path => $.fs.read(path),
        write: (path, text) => $.fs.write(path, text),
        list: path => $.fs.list(path),
        exists: path => $.fs.exists(path),
      },
      process: { run: (argv, init) => $.process.run(argv, init) },
    }
    const s = createSession({
      host,
      serverUrl,
      dataDir,
      platform: await platformOf($),
      setView: fn => update($, net, v => fn({ ...v, serverUrl })).then(() => undefined),
      toast: text => $.ui.toast(text),
    })
    session = s
    void s.start()
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.end', ($, e, next) => {
    session?.stop()

    return next(e)
  })

  on('command.run', { command: 'games' }, async ($, e) => {
    const s = session
    const arg = e.args.trim().toLowerCase()
    if (!s) return { text: 'Games is still starting; try again in a moment.' }
    switch (arg) {
      case '':
        await $.ui.open({ id: PANE, title: TITLE })
        return { text: 'Games pane opened.' }
      case 'login':
        void $.ui.open({ id: PANE, title: TITLE })
        return { text: await s.login() }
      case 'logout':
        return { text: await s.logout() }
      case 'status':
        return { text: s.status() }
      case 'sync':
        return { text: await s.sync() }
      default:
        return { text: HELP }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v: NetView = await read($, net)
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

    return (
      <Box flexDirection="column">
        <Text bold>Games</Text>
        <Text>{who}</Text>
        {v.login && (
          <Box flexDirection="column" marginTop={1}>
            <Text>Approve this code in your browser:</Text>
            <Text bold color="cyan">
              {v.login.userCode}
            </Text>
            <Text dimColor>{v.login.uriComplete}</Text>
            {v.login.canOpen && (
              <Button key="open-login" onPress={() => void session?.openLoginUrl()}>
                Open in browser
              </Button>
            )}
          </Box>
        )}
        {v.message && <Text color="yellow">{v.message}</Text>}
        {v.phase === 'signed-in' && (
          <Text dimColor>
            Online games {v.online.games} · challenges {v.online.challenges} · offers {v.online.offers}
            {v.online.isQueued ? ' · in the lobby' : ''}
          </Text>
        )}
        <Text dimColor>
          Offline games {v.offline.files}
          {v.offline.pending ? ` (${v.offline.pending} not uploaded)` : ''}
        </Text>
      </Box>
    )
  })
}
