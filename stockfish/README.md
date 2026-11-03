# Stockfish

Offline chess against the computer uses Stockfish when it is here, and the mod's own small search
otherwise. The binary is not kept in git (about 100 MB). Stockfish is GPLv3: see `COPYING` and
https://stockfishchess.org.

Windows (x86-64):

    gh release download sf_19 -R official-stockfish/Stockfish -p "stockfish-windows-x86-64-universal.zip"

Unzip it and put the `.exe` in this folder as `stockfish.exe`. On Linux or macOS put the binary
here as `stockfish` (executable).

The mod runs it once per move (`hooks/engine/stockfish.ts`). Check it by hand:

    printf 'uci\nposition startpos moves e2e4\ngo depth 8\n' | ./stockfish.exe
