# terminal-games

A Claude Code mod: a "Games" pane beside the chat.

- **Chess online** against other players: an open lobby with rating ranges and time controls,
  friends and player-to-player chat (needs an account, see below).
- **Chess offline** against the computer, ten levels.
- **Arcade games** offline: Snake, Pong, Bricks and Dodge.

## Install

```
/plugin install terminal-games --marketplace mrdogeman1/terminal-games
```

The pane opens when a session starts. The `/games` command:

| Command | What it does |
| --- | --- |
| `/games` | Open the pane |
| `/games login` | Sign in with a code you approve in the browser (device login) |
| `/games logout` | Sign out |
| `/games status` | Server, account and where offline games are kept |
| `/games sync` | Upload offline games that are not on the server yet |

## Logging in

Offline games need no account. To play online, run `/games login`: the mod shows a short code and
a link; open the link, sign in (or create an account) on the server and approve the code. Your
sign-in is kept in Claude Code's plugin store, never in a file.

The production server is https://arcade.skywars.fun. You can also play there in the browser.

## Offline games

Every finished offline game is one readable JSON file (moves plus PGN) in

```
<CLAUDE_CONFIG_DIR or ~/.claude>/terminal-games/games/
```

named `YYYYMMDD-HHmmss-<id>.json`. After you sign in they are uploaded to your account once; the
files stay where they are.

## Settings

Plugin options (`/plugin`, then terminal-games, then configure):

- `serverUrl`: the game server, default `https://arcade.skywars.fun` (also used when empty). Set it
  to e.g. `http://localhost:3000` for a local dev server.
- `dataDir`: folder for offline games instead of the default above.

## Stockfish (optional)

Offline chess uses Stockfish when it is there, and the mod's own small engine otherwise. Stockfish
is not bundled: it is GPLv3 (`stockfish/COPYING`) and about 100 MB. Download it yourself and put
the binary in `stockfish/` as described in `stockfish/README.md`.

## Development

```
claude plugin validate .
claude plugin test .
tsc -p .
```

CI runs the first two on every push and pull request. `tsc -p .` needs the types in
`.claude-plugin/types/`, which Claude Code writes there once it has loaded the mod (for example
with `claude --plugin-dir <this folder>`).

The mod talks to the server over HTTP only. `docs/PROTOCOL.md` is the client contract: every
endpoint, event and error the mod relies on. It is a copy of the server's protocol document;
protocol changes land there first.

## License

MIT, see `LICENSE`. Stockfish, if you add it, is GPLv3.
