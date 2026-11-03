# terminal-games

A Claude Code mod: a "Games" pane beside the chat. Play chess offline against an engine, or sign in
to play online (open lobby with rating ranges and time controls, friends, chat).

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

Your sign-in is kept in Claude Code's plugin store, never in a file.

## Offline games

Every finished offline game is one readable JSON file (moves plus PGN) in

```
<CLAUDE_CONFIG_DIR or ~/.claude>/terminal-games/games/
```

named `YYYYMMDD-HHmmss-<id>.json`. After you sign in they are uploaded to your account once; the
files stay where they are.

## Settings

Plugin options (`/plugin`, then terminal-games, then configure):

- `serverUrl`: the game server. Empty means `http://localhost:3000` (development).
- `dataDir`: folder for offline games instead of the default above.

## Stockfish (optional)

Put a Stockfish binary in `stockfish/` (see `stockfish/README.md`) for a stronger engine. Without
it the built-in engine plays. Stockfish is GPLv3 (`stockfish/COPYING`).

## Development

```
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc -p .` needs the types in `.claude-plugin/types/`, which Claude Code writes there once it
has loaded the mod (for example with `claude --plugin-dir <this folder>`).

## License

MIT, see `LICENSE`.
