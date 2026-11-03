# PROTOCOL.md: mod <-> server contract

Version: **API v1** (draft 4, 2026-11-03; not shipped, so still v1). Owner: protocol. Status:
binding for all Phase 1 teams.

Draft 4 changes: open lobby instead of tier matchmaking (auto-match by rating range and accepted
time-control options, plus manual offers), time control as two independent dimensions (game clock
and per-move limit), challenges are offers, one persistent chat thread per user pair with system
entries, and messaging blocks.

This is the contract between the Claude Code mod `terminal-games` (the client; plugin
name `terminal-games`, public repo and marketplace `mrdogeman1/terminal-games`) and the T3 web app
(the server). The server teams (auth, game-core, social) implement it under
`web/src/app/api/mod/*` on top of the same services the browser's tRPC routers use; the mod team
codes against it with `$.http.fetch`. If something here is unclear or wrong, fix this file first
(through the lead), then the code.

Keywords MUST / SHOULD / MAY are used as in RFC 2119.

## Table of contents

1. [Transport and conventions](#1-transport-and-conventions)
2. [Errors, status codes, rate limits](#2-errors-status-codes-rate-limits)
3. [Versioning](#3-versioning)
4. [Authentication: device flow](#4-authentication-device-flow)
5. [Shared types](#5-shared-types)
6. [Time controls, clocks and deadlines](#6-time-controls-clocks-and-deadlines)
7. [Endpoints: account](#7-endpoints-account)
8. [Endpoints: games](#8-endpoints-games)
9. [Endpoints: lobby, auto-match, offers and challenges](#9-endpoints-lobby-auto-match-offers-and-challenges)
10. [Endpoints: friends](#10-endpoints-friends)
11. [Endpoints: chat](#11-endpoints-chat)
12. [Endpoints: blocks](#12-endpoints-blocks)
13. [Endpoints: offline import](#13-endpoints-offline-import)
14. [Events: long-poll](#14-events-long-poll)
15. [Event types and payloads](#15-event-types-and-payloads)
16. [Browser equivalent: tRPC](#16-browser-equivalent-trpc)
17. [Offline game file format (mod)](#17-offline-game-file-format-mod)
18. [Mod client lifecycle (informative)](#18-mod-client-lifecycle-informative)
19. [Server implementation notes](#19-server-implementation-notes)
20. [Endpoint index](#20-endpoint-index)

---

## 1. Transport and conventions

**The mod's only network primitive** is `$.http.fetch(url, { method, headers, body })` returning
`{ status, ok, headers, text }`. Plain request/response: no WebSocket, no SSE, no streaming.
Everything in this API is a single JSON request answered by a single JSON response. Real-time
updates come from a long-poll (section 14).

- **Base URL**: configured in the mod (`serverUrl` setting; default is the production URL). All
  paths below are relative to it. HTTPS in production.
- **Bodies**: `Content-Type: application/json; charset=utf-8` on every request with a body and on
  every response. The mod parses `res.text` with `JSON.parse`. POST requests without parameters
  send `{}`; GET and DELETE send no body.
- **Required headers** on every `/api/mod/*` request:
  - `X-Mod-Version: <semver>` (the mod's version, e.g. `0.1.0`), on every route including
    `GET /api/mod/version`. A request without it gets `400 bad_request` (`field: "X-Mod-Version"`).
  - `Authorization: Bearer <token>`, except on `GET /api/mod/version`. The device-flow endpoints
    `/api/auth/device/*` take no bearer token.
  - `X-Client-Id: <uuid>`: a UUID v4 the mod generates once per install and keeps in `$.store`
    (`"clientInstanceId"`; not the same thing as an offline game's `clientId`). It never changes
    on login/logout. Missing or malformed: `400 bad_request`. It identifies the client instance
    (used by the long-poll, section 2.3); it is not a credential.
- **IDs** are opaque strings (cuid). Never parse them.
- **Timestamps** are ISO 8601 UTC strings (`"2026-11-03T14:05:09.123Z"`), except `serverTime`
  and clock fields, which are integer milliseconds (`serverTime` = Unix epoch ms).
- **`seq`** (event sequence) is a Postgres `BigInt`, serialized as a JSON **number**. The server
  guarantees it stays below 2^53. Query strings carry it as decimal text.
- **Usernames**: 3-20 chars, `[A-Za-z0-9_]`, unique case-insensitively. Every endpoint that takes
  a username matches case-insensitively; responses return the stored spelling.
- **Ratings**: integer Elo, shown everywhere a player is listed (every `UserRef` carries it).
- **Colors**: `"white" | "black"`. **Moves** on the wire are UCI (`e2e4`, `e7e8q`, `e1g1` for
  castling); the server answers SAN.
- **Pagination**: cursor-based. Request `?limit=<n>&cursor=<opaque>`; the response carries
  `nextCursor: string | null` (null = no more). Default `limit` 20, max 100 (larger values are
  clamped, not rejected). Chat messages use `before` instead of `cursor` (section 11).
- **Unknown fields**: clients MUST ignore unknown response fields and unknown event types; servers
  MUST ignore unknown request fields. This is how the API grows without a version bump.
- Every authenticated request updates `User.lastSeenAt` (used for presence, section 15.14, and
  lobby staleness, section 9).

## 2. Errors, status codes, rate limits

### 2.1 Error envelope

Every non-2xx response from `/api/mod/*` has this body:

```ts
interface ApiError {
  error: ErrorCode;         // stable machine code; switch on this
  message: string;          // human-readable English, safe to show in the pane
  [extra: string]: unknown; // code-specific fields, listed per code below
}

type ErrorCode =
  | "bad_request" | "illegal_move" | "not_supported"
  | "unauthorized"
  | "forbidden" | "banned" | "username_required" | "blocked"
  | "not_found"
  | "not_your_turn" | "stale_state" | "game_not_active" | "already_in_game"
  | "draw_already_offered" | "no_draw_offer" | "not_queued" | "offer_not_pending" | "conflict"
  | "events_expired"
  | "payload_too_large"
  | "upgrade_required"
  | "rate_limited"
  | "internal" | "unavailable";
```

Clients MUST handle an unknown `error` value by its HTTP status class (new codes may be added).

The device-flow endpoints under `/api/auth/device/*` belong to Better Auth and use the OAuth
shape `{ error, error_description }` instead (section 4).

### 2.2 Error codes

| HTTP | `error` | When | Extra fields |
|---|---|---|---|
| 400 | `bad_request` | Malformed JSON, missing/invalid field (incl. an invalid time control, an offer time control the target does not accept, invalid lobby settings), missing `X-Mod-Version` / `X-Client-Id` | `field?: string` |
| 400 | `illegal_move` | Move is not legal in the current position | `fen: string` |
| 400 | `not_supported` | Action not available for this game (e.g. draw offer vs computer) | |
| 401 | `unauthorized` | Missing, invalid, expired or revoked bearer token | |
| 403 | `forbidden` | Authenticated but not allowed (e.g. accepting your own offer) | |
| 403 | `banned` | Account is banned (role `BANNED`; every bearer endpoint answers this) | `until?: string` |
| 403 | `username_required` | Account has no username yet (finish onboarding on the web) | `url: string` |
| 403 | `blocked` | Messaging or friend request between users where either blocked the other | |
| 404 | `not_found` | Unknown game, user, thread, offer or friendship, or one you may not see | |
| 409 | `not_your_turn` | Move submitted when it is the other side's turn | |
| 409 | `stale_state` | `expectedPly` did not match the game's `plyCount` | `plyCount: number` |
| 409 | `game_not_active` | Game action needs `status: "active"` | `status: GameStatus` |
| 409 | `already_in_game` | Would give a user a second active **live** game (section 9.6) | `gameId: string` |
| 409 | `draw_already_offered` | You already have a pending draw offer in this game | |
| 409 | `no_draw_offer` | Accept/decline with no pending offer from the opponent | |
| 409 | `not_queued` | Lobby offer to a user who has no lobby entry | |
| 409 | `offer_not_pending` | Accept/decline of an offer that is no longer pending | `status: OfferStatus` |
| 409 | `conflict` | Other state conflict (friend request to yourself, duplicate pending offer, ...) | |
| 410 | `events_expired` | `since` is older than the retained event log, or newer than the head | `seq: number` |
| 413 | `payload_too_large` | Body over 256 KB, or an import batch over 50 games | |
| 426 | `upgrade_required` | `X-Mod-Version` below the server's minimum | `minVersion: string` |
| 429 | `rate_limited` | Rate limit hit | `retryAfterMs: number` |
| 500 | `internal` | Server bug | |
| 503 | `unavailable` | Maintenance / database down | `retryAfterMs?: number` |

Client rules:

- `401`: drop the stored token, show "signed out", offer `/games login`.
- `426`: stop all online traffic and tell the user to update the mod
  (`/plugin update terminal-games`).
- `429` / `503`: wait `retryAfterMs` (or the `Retry-After` header, in seconds) before retrying.
- Network errors (fetch throws, or status 0): back off 2 s, 4 s, 8 s, ... max 30 s.

### 2.3 Rate limits

Per authenticated user unless noted, sliding windows. Exceeding a limit returns
`429 rate_limited` with `retryAfterMs` and a `Retry-After` header.

| Scope | Limit |
|---|---|
| All `/api/mod/*` requests except `events` | 120 / minute |
| `GET /api/mod/events` | 1 in flight per token + `X-Client-Id`; 60 / minute per user |
| `POST .../move` | 5 / second, 120 / minute |
| `POST /api/mod/games` (computer games and challenges) | 10 / 10 minutes |
| `POST /api/mod/queue/:userId/offer` | 20 / 10 minutes |
| `POST /api/mod/chat/threads/:id/messages` | 10 / 10 seconds, 200 / hour |
| `POST /api/mod/friends/request` | 20 / hour |
| `POST /api/mod/chat/dm` | 30 / hour |
| `POST/DELETE /api/mod/blocks/:userId` | 30 / hour |
| `POST /api/mod/offline/import` | 10 / hour |
| `POST /api/auth/device/code` | 10 / hour per IP |

"Newest request wins" is keyed on **token + `X-Client-Id`**: a second `GET /api/mod/events` from
the same token and client id while one is held does not get `429`; the older held request is
answered at once with what it has (possibly `events: []`) and the new one takes over. A stuck
client thus heals itself, while two installs sharing one account each keep their own long-poll.

## 3. Versioning

- The API version is `1`. Breaking changes get a new path prefix (`/api/mod/v2/*`); additive
  changes (new fields, new event types, new endpoints) do not.
- The mod sends `X-Mod-Version`. If it is below the server's `minModVersion`, every `/api/mod/*`
  endpoint except `GET /api/mod/version` answers
  `426 { error: "upgrade_required", message, minVersion }`.

### `GET /api/mod/version`

No auth. Called once at startup, before login.

```ts
interface VersionResponse {
  apiVersion: 1;
  minModVersion: string;    // semver, e.g. "0.1.0"
  latestModVersion: string; // semver; the mod MAY show "update available"
  serverTime: number;       // epoch ms
}
```

```http
GET /api/mod/version
X-Mod-Version: 0.1.0
X-Client-Id: 0b6c2a8e-6f0d-4f57-a4a5-2b1f7c9d3e10

200 {"apiVersion":1,"minModVersion":"0.1.0","latestModVersion":"0.1.2","serverTime":1793714709123}
```

## 4. Authentication: device flow

The mod signs in with the Better Auth 1.7 `deviceAuthorization` plugin (RFC 8628). The resulting
`access_token` is a Better Auth **session token**, accepted as `Authorization: Bearer <token>`
through the `bearer` plugin. The browser is used only to sign in and approve.

### 4.1 Request a code

```http
POST /api/auth/device/code
Content-Type: application/json

{"client_id":"claude-games"}
```

```ts
interface DeviceCodeResponse {
  device_code: string;               // secret, never shown
  user_code: string;                 // e.g. "WDJB-MJHT"; show it big
  verification_uri: string;          // e.g. "https://<host>/device"
  verification_uri_complete: string; // same, with ?user_code=... prefilled
  expires_in: number;                // seconds (server default 1800)
  interval: number;                  // seconds between polls (server default 5)
}
```

```http
200 {"device_code":"Ag_EE...ilk","user_code":"WDJB-MJHT","verification_uri":"https://games.example.com/device","verification_uri_complete":"https://games.example.com/device?user_code=WDJB-MJHT","expires_in":1800,"interval":5}
```

The mod shows `Open <verification_uri_complete> and approve code WDJB-MJHT` (both the URL and
the code, so it also works when the user types `verification_uri` by hand). It MAY open the URL in
the default browser via `$.process.run` (Windows: `rundll32 url.dll,FileProtocolHandler <url>`, since `$.process.run` takes argv only, no shell; the mod validates that the URL origin equals the configured server origin first) when the user asks.
Before opening it, the mod MUST check that the URL is `https:` (or `http:` for a localhost dev
server) and that its origin equals the configured `serverUrl` origin; otherwise it only shows the
URL and does not open it. The URL is passed as one argument, never through string-built shell
commands.

The web page `/device` (auth team) makes the user sign in (or sign up, verify the email and pick a
username), shows the code, and has Approve / Deny buttons that call Better Auth's
`/api/auth/device/approve` / `/api/auth/device/deny` with the browser session. The server's
`validateClient` MUST accept only `client_id === "claude-games"` (the device-flow client id keeps
this name; only the plugin is called `terminal-games`).

### 4.2 Poll for the token

Start polling right away, every `interval` seconds, until success, a terminal error, or until
`expires_in` has passed (then show "code expired, run /games login again").

```http
POST /api/auth/device/token
Content-Type: application/json

{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"Ag_EE...ilk","client_id":"claude-games"}
```

Success (`200`):

```ts
interface DeviceTokenResponse {
  access_token: string; // Better Auth session token
  token_type: "Bearer";
  expires_in: number;   // seconds until the session expires (sliding, see 4.4)
  scope: string;        // unused, ""
}
```

Errors are `400 { error, error_description }`. The mod MUST handle each:

| `error` | Meaning | Mod action |
|---|---|---|
| `authorization_pending` | User has not approved yet | Keep polling at the current interval |
| `slow_down` | Polling too fast | Add 5 s to the interval for the rest of this flow, keep polling |
| `access_denied` | User pressed Deny | Stop; show "login denied" |
| `expired_token` | Code expired | Stop; show "code expired, run /games login again" |
| `invalid_grant`, `invalid_request`, other | Bad device_code or client | Stop; show `error_description`, offer to retry |

A network error or a 5xx while polling is not terminal: retry at the current interval.

### 4.3 Verify and store

Right after success the mod calls `GET /api/mod/me` with the new token (section 7). On `200` it
stores, in `$.store` under key `"auth"`:

```ts
interface StoredAuth {
  serverUrl: string;  // base URL the token belongs to; the token is invalid for any other server
  token: string;      // access_token
  userId: string;
  username: string;
  obtainedAt: string; // ISO
}
```

The token is a credential: it MUST NOT be written to offline game files, logs, the pane, or any
file in the user's project. `$.store` only. After storing, the mod uploads pending offline games
(section 13).

### 4.4 Token lifetime, refresh, logout

- The session is sliding (server config: 30 days, extended on use). There is no refresh token.
- If a response carries a `set-auth-token` header (bearer plugin), the mod MUST replace the
  stored token with its value.
- `401` on any call means the session is gone: delete `"auth"` from `$.store`, show "signed out",
  offer `/games login`.
- Logout (`/games logout`): `POST /api/mod/logout` (below), then delete `"auth"` whatever the
  result. The mod does not use Better Auth's `/api/auth/sign-out` (its origin/CSRF check is meant
  for browsers).

### `POST /api/mod/logout`

Bearer auth, body `{}`. Revokes the session behind the bearer token server-side (delete the
Session row). Idempotent: an already revoked or unknown token also gets `200` (not `401`), so
logout never fails for the client. The user's lobby entry expires by staleness; games are not
touched.

```ts
interface LogoutResponse { ok: true }
```

```http
POST /api/mod/logout
Authorization: Bearer 3fQ...x9
X-Mod-Version: 0.1.0
X-Client-Id: 0b6c2a8e-6f0d-4f57-a4a5-2b1f7c9d3e10

{}

200 {"ok":true}
```

## 5. Shared types

```ts
type Color = "white" | "black";
type GameMode = "online" | "computer";
type GameStatus = "waiting" | "active" | "finished" | "aborted"; // "waiting" is unused in v1
type GameResult = "1-0" | "0-1" | "1/2-1/2";
type GameSource = "web" | "mod";

// Time control: two independent dimensions (section 6).
interface GameClock { initialMs: number; incrementMs: number; }
type GameClockOption = GameClock | null; // null = no overall game clock
type PerMoveOption = number | null;      // reply limit per move in ms; null = none
interface TimeControl {
  gameClock: GameClockOption;
  perMoveMs: PerMoveOption;
}
// { gameClock: null, perMoveMs: null } = unlimited.

interface RatingRange {
  min: number | null; // inclusive absolute rating; null = no lower bound
  max: number | null; // inclusive absolute rating; null = no upper bound
}

type GameReason =
  // finished, decisive
  | "checkmate" | "resign"
  | "timeout"                 // game clock flag fell, or a per-move deadline passed
  | "abandoned"               // online game: side to move silent for 7 days (section 6.4)
  // finished, draw
  | "stalemate" | "insufficient_material" | "threefold" | "fifty_move" | "agreement"
  | "timeout_vs_insufficient" // time ran out, but the opponent cannot mate
  | "max_plies"               // offline import only (the mod's 300-ply cap)
  // aborted (no result, no rating change)
  | "aborted"                 // a player resigned before both sides had moved
  | "no_first_move";          // a first-move deadline passed (section 6.4)
  // computer games idle 7 days are aborted with reason "abandoned"

interface UserRef {
  userId: string;
  username: string;
  rating: number; // current Elo
}

interface PlayerInfo {
  kind: "user" | "guest" | "engine";
  userId: string | null;   // null for guest/engine
  username: string | null; // null for guest/engine (clients show "Guest" / "Engine level N")
  rating: number | null;   // current rating; null for guest/engine
  online: boolean | null;  // presence; null for guest/engine
}

interface MoveInfo {
  ply: number;            // 1-based: ply 1 = white's first move
  san: string;            // "Nf3", "exd8=Q+", "O-O"
  uci: string;            // "g1f3", "e7d8q", "e1g1"
  fenAfter: string;
  clockMs: number | null; // with a game clock: mover's remaining time after the move (incl. increment); else null
  at: string;             // ISO
}

interface ClockState {
  initialMs: number;     // e.g. 300000 for 5+0
  incrementMs: number;   // e.g. 10000 for 15+10
  whiteMs: number;       // remaining, computed at serverTime
  blackMs: number;
  running: Color | null; // whose clock is ticking at serverTime; null = none
  serverTime: number;    // epoch ms at which whiteMs/blackMs were computed
}

interface GameSummary {
  id: string;
  mode: GameMode;
  source: GameSource;
  timeControl: TimeControl;
  engineLevel: number | null;
  rated: boolean;
  status: GameStatus;
  result: GameResult | null;
  reason: GameReason | null;
  white: PlayerInfo;
  black: PlayerInfo;
  you: Color;                    // your color (in computer games: the human side)
  turn: Color;                   // side to move in `fen`
  fen: string;
  plyCount: number;
  lastMove: { uci: string; san: string } | null;
  moveDeadlineAt: string | null; // section 6.3
  ratingDeltaWhite: number | null; // set when a rated game finishes
  ratingDeltaBlack: number | null;
  createdAt: string;
  lastMoveAt: string | null;
}

interface GameState extends GameSummary {
  pgn: string;              // full PGN with headers; result "*" while not finished
  moves: MoveInfo[];        // all moves, ply ascending
  clock: ClockState | null; // only when timeControl.gameClock is set
  serverTime: number;       // epoch ms when this state was read
  drawOffer: Color | null;  // side with a pending draw offer
  inCheck: boolean;         // side to move is in check
  legalMoves: string[];     // UCI moves for the side to move; [] unless canMove
  canMove: boolean;         // you may POST a move now
  canResign: boolean;
  canAbort: boolean;        // resigning now would abort (online, plyCount < 2)
  canOfferDraw: boolean;    // online, active, no pending offer of yours
  canAcceptDraw: boolean;   // the opponent's offer is pending
  chatThreadId: string | null; // the pair thread with your opponent (online games)
  eventSeq: number;         // event-log head when this snapshot was read (section 14.4)
}
```

**Rated**: every `online` game is rated (Elo, K=32, start 1200), except aborted ones. `computer`
games and imported games are never rated. Ratings are per user, one number for all time
controls.

**Elo computation**: from the **pre-game** ratings `Rw`, `Rb`:
`Ew = 1 / (1 + 10^((Rb - Rw) / 400))`, `Eb = 1 - Ew`, scores `Sw`/`Sb` = 1, 0.5 or 0.
`ratingDeltaWhite = round(32 * (Sw - Ew))`, `ratingDeltaBlack = round(32 * (Sb - Eb))`, each
computed independently and rounded to the nearest integer (halves away from zero). Because of the
independent rounding the two deltas may not sum to exactly zero; that is intended.

**Tier labels** (display only; matchmaking does not use them): clients derive the label from the
rating: `Beginner` < 1000, `Casual` 1000-1299, `Club` 1300-1599, `Expert` >= 1600. No tier field
is sent on the wire.

**Engine levels** (`engineLevel`): integer 1-10. Each client maps it to its own engine settings
(the mod team maps the mod's existing levels into this range). The server only stores it.

## 6. Time controls, clocks and deadlines

### 6.1 The two dimensions and their allowed values

A time control has two **independent** dimensions; a game can have either, both, or neither.

| Dimension | Allowed values | Label |
|---|---|---|
| `gameClock` | `null` (no game clock), or exactly one of `{initialMs: 300000, incrementMs: 0}`, `{600000, 0}`, `{900000, 10000}` | `5+0`, `10+0`, `15+10`; null: no label |
| `perMoveMs` | `null` (no reply limit), or an integer number of ms that is a whole number of seconds, 30000-604800000. Presets: 60000, 180000, 300000, 1800000, 3600000, 86400000, 259200000 | `1 min/move`, `3 min/move`, `5 min/move`, `30 min/move`, `1 h/move`, `1 day/move`, `3 days/move`; custom: largest exact unit (`90 s/move`, `2 days/move`) |

- **Default** time control: `{ gameClock: null, perMoveMs: 180000 }` (3 minutes per move).
- Both null = **unlimited** (label `Unlimited`; ends only by the 7-day rule, 6.4).
- Combined label: clock and per-move joined with ` + `, e.g. `5+0 + 1 min/move`.
- Anything else: `400 bad_request { field: "timeControl" }` (or the field path of the lobby
  setting).
- **Equality**: two `GameClockOption`s are equal when both are null or both numbers match; two
  `PerMoveOption`s when the values are equal (null equals null).
- The server stores a canonical key in `Game.timeControl` (and the offer row):
  `"<clock>|<perMove>"`, where `<clock>` is `5+0`, `10+0`, `15+10` or `-`, and `<perMove>` is the
  limit in whole seconds or `-`. Examples: `"-|180"`, `"5+0|-"`, `"-|-"`. The key never appears
  on the wire.
- Computer games are always `{ gameClock: null, perMoveMs: null }`.
- A game is **live** when it has a game clock, or a `perMoveMs` of 1 hour or less. Other games
  (longer per-move limits, unlimited) are **correspondence** games. This matters for the
  active-game limit (9.6).

### 6.2 Game clock

- **Start**: the clocks do not run until both sides have moved once (first-move deadlines, 6.4).
  After ply 2, white's clock runs.
- **On each move** from ply 3 on: the mover's time since the previous move is subtracted, then the
  increment is added, and the opponent's clock starts. Plies 1 and 2 cost no time and get no
  increment (their `clockMs` is the initial time). The server stores the mover's remaining time in
  `Move.clockMs` and updates `Game.whiteMs`, `Game.blackMs`, `Game.lastMoveAt`.
- **The server is the only clock authority.** Every `ClockState` gives remaining milliseconds
  computed at `serverTime`: the running side's stored value minus `serverTime - lastMoveAt`,
  floored at 0.
- **Client extrapolation**: when a `ClockState` arrives, record the local receive time
  `t0 = $.clock.now()` (browser: `Date.now()`). Display the running side as
  `max(0, ms - (now - t0))` and the other side as `ms`. Do not subtract using `serverTime`
  (client and server clocks can differ). The shown time is thus at most one network latency more
  generous than the server's.
- **Flag**: when a shown clock reaches 0 the client shows 0 and waits; it MUST NOT end the game
  itself. The server flags with its maintenance loop (at least every 1 s) and on any request that
  touches the game, and emits `game.over` with reason `timeout`, or `timeout_vs_insufficient`
  (a draw) when the side with time left has insufficient mating material.

### 6.3 Per-move limit and `moveDeadlineAt`

- With `perMoveMs` set, each move from ply 3 on must be made within `perMoveMs` of the previous
  move. It applies **in addition to** a game clock, if there is one: whichever runs out first
  ends the game. No time bank, no increment.
- When the deadline passes, the side to move **loses**, reason `timeout` (or a draw,
  `timeout_vs_insufficient`, when the opponent has insufficient mating material).
- `moveDeadlineAt` (ISO) in `GameSummary`/`GameState` and in every `game.move` payload is the
  moment the side to move runs out of its per-move or first-move time:
  - `plyCount < 2` (any online game): the first-move deadline (6.4);
  - `plyCount >= 2` and `perMoveMs` set: `lastMoveAt + perMoveMs`;
  - otherwise (no per-move limit, finished, computer games): `null`. A game clock's flag time is
    not put here; it follows from `clock`.
- Client display: countdown `Date.parse(moveDeadlineAt) - serverTime`, extrapolated from the
  local receive time `t0` like a clock (`remaining - (now - t0)`). With both a clock and a
  deadline, show both.

### 6.4 Deadlines, auto-abort and abandonment

Every game that is not `finished`/`aborted` ends by itself eventually, so `already_in_game` always
clears. The server's maintenance loop (every 1-2 s, section 19) applies:

| Game state | Deadline | Outcome |
|---|---|---|
| Online, `plyCount < 2`, has a game clock | 60 s for each first move (ply 1 from game start, ply 2 from ply 1) | `aborted`, `no_first_move` |
| Online, `plyCount < 2`, no game clock, `perMoveMs` set | `perMoveMs` for each first move | `aborted`, `no_first_move` |
| Online, `plyCount < 2`, unlimited | 7 days for each first move | `aborted`, `no_first_move` |
| Online, `plyCount >= 2`, game clock | flag falls | `finished`, `timeout` (or draw `timeout_vs_insufficient`) |
| Online, `plyCount >= 2`, `perMoveMs` set | `moveDeadlineAt` passes | `finished`, `timeout` (or draw `timeout_vs_insufficient`) |
| Online, `plyCount >= 2`, unlimited | side to move has not moved for 7 days | `finished`, loss for the side to move, `abandoned` |
| Computer, `active` | no move for 7 days | `aborted`, `abandoned`, unrated |

Aborted games are unrated. Each outcome emits `game.over`. A move that arrives after its deadline
gets `409 game_not_active`: the deadline check runs before the move is applied.

## 7. Endpoints: account

### `GET /api/mod/me`

Checks the token and returns the user plus the current event-log head.

```ts
interface MeResponse {
  user: {
    id: string;
    username: string;
    rating: number;
    role: "USER" | "MODERATOR" | "ADMIN"; // banned users never get here: 403 banned
    createdAt: string;
  };
  eventSeq: number;            // current event-log head; start the long-poll here (section 14)
  activeGameIds: string[];     // your games with status "active", newest first
  queue: LobbyEntry | null;    // your lobby entry, if any (section 9)
  serverTime: number;
}
```

```http
GET /api/mod/me
Authorization: Bearer 3fQ...x9
X-Mod-Version: 0.1.0
X-Client-Id: 0b6c2a8e-6f0d-4f57-a4a5-2b1f7c9d3e10

200 {"user":{"id":"cm3u1","username":"luc","rating":1214,"role":"USER","createdAt":"2026-11-03T10:00:00.000Z"},"eventSeq":48211,"activeGameIds":[],"queue":null,"serverTime":1793714709123}
```

Errors: `401 unauthorized`, `403 banned`, `403 username_required` (with `url` of the onboarding
page), `426 upgrade_required`.

## 8. Endpoints: games

Players in `online` games are always signed-in users (browser guests only play the computer). A
user sees a game only when they are one of its players; otherwise `404 not_found`.

Online games start from a lobby auto-match or an accepted offer (lobby offer or challenge,
section 9). They start `active` at once; there are no `waiting` games in v1.

### `GET /api/mod/games?status=&limit=&cursor=`

Your games, most recent activity first (`lastMoveAt ?? createdAt`, descending).

- `status`: optional, comma-separated subset of `active,finished,aborted`. Default: all.
- `limit`, `cursor`: section 1.

```ts
interface GamesListResponse {
  games: GameSummary[];
  nextCursor: string | null;
}
```

```http
GET /api/mod/games?status=active&limit=10

200 {"games":[{"id":"g_7k2","mode":"online","source":"web","timeControl":{"gameClock":{"initialMs":600000,"incrementMs":0},"perMoveMs":null},"engineLevel":null,"rated":true,"status":"active","result":null,"reason":null,"white":{"kind":"user","userId":"cm3u1","username":"luc","rating":1214,"online":true},"black":{"kind":"user","userId":"cm9zz","username":"anna_b","rating":1190,"online":true},"you":"white","turn":"black","fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1","plyCount":1,"lastMove":{"uci":"e2e4","san":"e4"},"moveDeadlineAt":"2026-11-03T14:01:04.000Z","ratingDeltaWhite":null,"ratingDeltaBlack":null,"createdAt":"2026-11-03T14:00:00.000Z","lastMoveAt":"2026-11-03T14:00:04.000Z"}],"nextCursor":null}
```

### `POST /api/mod/games`

Creates a computer game, or sends a **challenge** (a direct offer to any user with a freely chosen
time control; section 9.5). The server sets `source: "mod"`.

```ts
type CreateGameRequest =
  | {
      mode: "computer";
      engineLevel: number;      // 1-10
      color: Color | "random";  // your color
    }
  | {
      mode: "online";
      opponentUsername: string;
      timeControl: TimeControl; // any allowed value (section 6.1)
      color?: Color | "random"; // your color; default "random"
    };

// computer: 201 GameState. online: 201 Offer (kind "challenge"; no game exists yet).
type CreateGameResponse = GameState | Offer;
```

**Computer games** start `active` with an unlimited time control, unrated. The engine runs on the
client (the mod's Stockfish or built-in search; the browser's WASM worker); the server never
computes moves. In a computer game the owner submits the moves of **both** sides through
`POST .../move`; the server checks legality and records them, so `canMove` is true whenever the
game is active. The engine side is `{ kind: "engine", userId: null, ... }`.

```http
POST /api/mod/games
{"mode":"online","opponentUsername":"Anna_B","timeControl":{"gameClock":null,"perMoveMs":86400000}}

201 {"id":"of_40","kind":"challenge","from":{"userId":"cm3u1","username":"luc","rating":1214},"to":{"userId":"cm9zz","username":"anna_b","rating":1190},"timeControl":{"gameClock":null,"perMoveMs":86400000},"fromColor":"random","status":"pending","createdAt":"2026-11-03T14:05:00.000Z","expiresAt":"2026-11-03T14:07:00.000Z","gameId":null}
```

### `GET /api/mod/games/:id`

Full `GameState` with clocks computed at response time. Use it when opening a game, after login,
after a `410`, and after any gap or `409`.

```http
GET /api/mod/games/g_7k2

200 {"id":"g_7k2", ... ,"pgn":"[Event \"Online\"]\n...\n1. e4 *","moves":[{"ply":1,"san":"e4","uci":"e2e4","fenAfter":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1","clockMs":600000,"at":"2026-11-03T14:00:04.000Z"}],"clock":{"initialMs":600000,"incrementMs":0,"whiteMs":600000,"blackMs":600000,"running":null,"serverTime":1793714709123},"serverTime":1793714709123,"moveDeadlineAt":"2026-11-03T14:01:04.000Z","drawOffer":null,"inCheck":false,"legalMoves":[],"canMove":false,"canResign":true,"canAbort":true,"canOfferDraw":true,"canAcceptDraw":false,"chatThreadId":"t_44","eventSeq":48212}
```

### `POST /api/mod/games/:id/move`

```ts
interface MoveRequest {
  uci: string;          // /^[a-h][1-8][a-h][1-8][qrbn]?$/ ; the promotion piece is required when promoting
  expectedPly?: number; // the game's plyCount the client based this move on (recommended)
}

interface MoveResponse {
  move: MoveInfo;  // the move just applied
  game: GameState; // state after the move (status may now be "finished")
}
```

Order of checks (the server MUST use this order):

1. Auth.
2. Game exists and you are a player (`404 not_found`).
3. **Idempotent retry**: if `expectedPly` is given, equals `plyCount - 1`, the last move's UCI
   equals `uci`, and that move was made by you (your color; in a computer game any move counts as
   yours), answer `200` with that move and the current state, whatever the status and turn now
   are. This is a retry after a lost response; it runs before the status and turn checks because
   after your move it is no longer your turn and the game may already be finished.
4. Server-side deadline check (section 6.4; may end the game).
5. `status` is `active` (`409 game_not_active`).
6. Your turn (`409 not_your_turn`; skipped in computer games).
7. Any other `expectedPly` mismatch: `409 stale_state { plyCount }`; the client refetches.
8. Legality with chess.js (`400 illegal_move`).

After applying the move the server detects checkmate, stalemate, insufficient material, threefold
repetition and the fifty-move rule, and **applies them automatically** (there is no claim
endpoint): the response's `game.status` is `finished`, and a `game.over` event follows. A move
clears a pending draw offer from the opponent (implicit decline, no `game.draw_declined` event);
your own pending offer stays.

```http
POST /api/mod/games/g_7k2/move
{"uci":"e7e5","expectedPly":1}

200 {"move":{"ply":2,"san":"e5","uci":"e7e5","fenAfter":"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2","clockMs":600000,"at":"2026-11-03T14:00:09.000Z"},"game":{"id":"g_7k2","status":"active","turn":"white","plyCount":2,"moveDeadlineAt":null, ... }}
```

```http
POST /api/mod/games/g_7k2/move
{"uci":"e2e5","expectedPly":2}

400 {"error":"illegal_move","message":"e2e5 is not a legal move","fen":"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"}
```

```http
POST /api/mod/games/g_7k2/move
{"uci":"d2d4","expectedPly":3}

409 {"error":"not_your_turn","message":"It is black's turn"}
```

### `POST /api/mod/games/:id/resign`

Body `{}`. Response `GameState`. In an online game with `plyCount < 2` this **aborts** instead
(`status: "aborted"`, `reason: "aborted"`, no result, unrated). In a computer game the engine side
wins. Errors: `404`, `409 game_not_active`.

### `POST /api/mod/games/:id/draw`

```ts
interface DrawRequest { action: "offer" | "accept" | "decline"; }
type DrawResponse = GameState;
```

- `offer`: needs an active online game and no pending offer of yours
  (`409 draw_already_offered`). If the opponent already offers, `offer` acts as `accept`. Allowed
  on either side's turn. Emits `game.draw_offer`.
- `accept`: needs a pending opponent offer (`409 no_draw_offer`). Finishes the game `1/2-1/2`,
  reason `agreement`, emits `game.over`.
- `decline`: needs a pending opponent offer (`409 no_draw_offer`). Emits `game.draw_declined`.
- Computer games: `400 not_supported`.

## 9. Endpoints: lobby, auto-match, offers and challenges

The lobby is an **open list** of players waiting for a game. Each user has at most one entry.
Everyone sees every entry (including its accepted/preferred options and rating range) and can
pick an opponent (manual offer); in addition the server pairs compatible entries automatically.
Tiers play no role.

### 9.1 Types

```ts
const MIN_RANGE = 50; // minimum half-width of a rating range, in Elo

interface OptionSet<T> {
  accepted: T[];  // non-empty, no duplicates
  preferred: T[]; // subset of accepted; may be empty (= no preference)
}

interface LobbySettings {
  ratingRange: RatingRange;           // absolute bounds; { min: null, max: null } = any
  gameClocks: OptionSet<GameClockOption>;
  perMove: OptionSet<PerMoveOption>;
}

interface LobbyEntry extends LobbySettings { // what everyone sees, you included
  userId: string;
  username: string;
  rating: number;
  since: string;                      // ISO, waiting since
}

type QueueJoinRequest = Partial<LobbySettings>; // omitted parts take the defaults below

interface LobbyResponse {
  entries: LobbyEntry[];              // everyone queued, you included, oldest first, max 200
  you: LobbyEntry | null;
  serverTime: number;
}

type OfferKind = "queue" | "challenge"; // lobby offer, or challenge via POST /api/mod/games
type OfferStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

interface Offer {
  id: string;
  kind: OfferKind;
  from: UserRef;
  to: UserRef;
  timeControl: TimeControl;           // the game's time control if accepted
  fromColor: Color | "random";        // sender's color
  status: OfferStatus;
  createdAt: string;
  expiresAt: string;                  // createdAt + 2 minutes
  gameId: string | null;              // set when accepted
}

interface OffersResponse {
  incoming: Offer[];                  // pending offers to you (hidden ones excluded, section 12)
  outgoing: Offer[];                  // your pending offers
}
```

**Defaults** (for each part of `QueueJoinRequest` that is omitted):
`ratingRange = { min: rating - 150, max: rating + 150 }`,
`gameClocks = { accepted: [null], preferred: [null] }`,
`perMove = { accepted: [180000], preferred: [180000] }`.

**Validation** (`400 bad_request { field }`, e.g. `field: "perMove.preferred"`): every option is
an allowed value (6.1); `accepted` non-empty, at most 4 game-clock options and 10 per-move
options, no duplicates; `preferred` ⊆ `accepted`; range bounds are integers or null with
`min <= max`. **Minimum width** is enforced by widening, not rejecting: the server sets
`min = min(min, rating - MIN_RANGE)` and `max = max(max, rating + MIN_RANGE)` (null stays null)
and returns the effective range.

### 9.2 Lobby endpoints

- `GET /api/mod/queue` -> `LobbyResponse`. The browser gets the same data through tRPC
  (section 16). There are no lobby-change events: clients refresh the list while the lobby view
  is open (SHOULD: every 5 s; counts against the general rate limit only).
- `POST /api/mod/queue` `QueueJoinRequest` -> `200 LobbyEntry` (your entry with effective
  settings). Joins, or replaces your entry (new settings, `since` reset; pending incoming lobby
  offers whose time control is no longer accepted are cancelled, reason `unavailable`).
  `409 already_in_game` if you have an active live game (9.6).
- `DELETE /api/mod/queue` -> `200 { left: boolean }` (false if you were not queued). Emits
  `match.cancelled { reason: "left" }` so your other clients update. Idempotent.

**Staleness**: an entry is removed when its user's `lastSeenAt` is older than 60 s (the mod's
long-poll keeps it fresh), with `match.cancelled { reason: "stale" }`.

Whenever an entry is removed for any reason, every pending **lobby** offer (`kind: "queue"`) to
that user is cancelled with reason `unavailable` (`offer.cancelled` to both sides). Challenges are
not affected.

```http
POST /api/mod/queue
{"ratingRange":{"min":1100,"max":1400},"gameClocks":{"accepted":[null,{"initialMs":300000,"incrementMs":0}],"preferred":[null]},"perMove":{"accepted":[180000,300000],"preferred":[180000]}}

200 {"userId":"cm3u1","username":"luc","rating":1214,"since":"2026-11-03T14:20:00.000Z","ratingRange":{"min":1100,"max":1400},"gameClocks":{"accepted":[null,{"initialMs":300000,"incrementMs":0}],"preferred":[null]},"perMove":{"accepted":[180000,300000],"preferred":[180000]}}
```

```http
POST /api/mod/queue
{}

200 {"userId":"cm3u1","username":"luc","rating":1214,"since":"2026-11-03T14:20:00.000Z","ratingRange":{"min":1064,"max":1364},"gameClocks":{"accepted":[null],"preferred":[null]},"perMove":{"accepted":[180000],"preferred":[180000]}}
```

```http
GET /api/mod/queue

200 {"entries":[{"userId":"cm9zz","username":"anna_b","rating":1190,"since":"2026-11-03T14:12:30.000Z","ratingRange":{"min":null,"max":null},"gameClocks":{"accepted":[null],"preferred":[null]},"perMove":{"accepted":[86400000],"preferred":[86400000]}},{"userId":"cm3u1","username":"luc","rating":1214,"since":"2026-11-03T14:20:00.000Z","ratingRange":{"min":1064,"max":1364},"gameClocks":{"accepted":[null],"preferred":[null]},"perMove":{"accepted":[180000],"preferred":[180000]}}],"you":{"userId":"cm3u1", ... },"serverTime":1793715609000}
```

### 9.3 Auto-match

The matcher runs every 2 s. Two entries A and B are **compatible** when all hold:

1. `rating(A)` lies within B's `ratingRange` and `rating(B)` within A's (inclusive; null bound =
   open);
2. `A.gameClocks.accepted ∩ B.gameClocks.accepted` is non-empty;
3. `A.perMove.accepted ∩ B.perMove.accepted` is non-empty;
4. neither player has an active live game (9.6).

**Pairing order**: entries are processed oldest `since` first; each unpaired entry is paired with
the oldest compatible unpaired entry.

**Choosing the time control**, independently per dimension (game clock, per-move):
`P = A.preferred ∩ B.preferred`; if `P` is non-empty pick uniformly at random from `P`, else pick
uniformly at random from `A.accepted ∩ B.accepted`. The two picks form the game's `TimeControl`.

There is **no confirmation step** and no refusal: the game starts at once (9.6), colors random,
and both players get `match.found { via: "queue", timeControl }`. **Blocks are ignored** by
auto-match. There is no automatic widening: a player who wants more opponents widens their own
range or options (re-`POST` the entry).

### 9.4 Lobby offers

Any signed-in user (queued or not) can send an offer to a **queued** user. The sender picks one
option per dimension from the **receiver's accepted** sets.

```ts
interface LobbyOfferRequest {
  timeControl: TimeControl;  // gameClock ∈ receiver.gameClocks.accepted, perMoveMs ∈ receiver.perMove.accepted
  color?: Color | "random";  // your color; default "random"
}
```

- `POST /api/mod/queue/:userId/offer` `LobbyOfferRequest` -> `201 Offer` (`kind: "queue"`).
  Errors: `404 not_found` (unknown user), `409 not_queued` (no lobby entry),
  `400 bad_request { field: "timeControl" }` (not in the receiver's accepted sets),
  `409 conflict` (yourself, or you already have a pending offer to that user),
  `409 already_in_game` (live time control and you have an active live game). Emits
  `offer.received` to the receiver, unless the receiver has blocked you: then the offer is
  created and listed for you as usual, but hidden from the receiver, and it simply expires.

```http
POST /api/mod/queue/cm9zz/offer
{"timeControl":{"gameClock":null,"perMoveMs":86400000}}

201 {"id":"of_31","kind":"queue","from":{"userId":"cm3u1","username":"luc","rating":1214},"to":{"userId":"cm9zz","username":"anna_b","rating":1190},"timeControl":{"gameClock":null,"perMoveMs":86400000},"fromColor":"random","status":"pending","createdAt":"2026-11-03T14:21:00.000Z","expiresAt":"2026-11-03T14:23:00.000Z","gameId":null}
```

### 9.5 Challenges and answering offers

A **challenge** is an offer to any user (queued or not, friend or not) with a freely chosen time
control, sent with `POST /api/mod/games { mode: "online", ... }` (section 8). It behaves exactly
like a lobby offer, except that it is not tied to the receiver's lobby entry. Blocked senders are
hidden in the same way.

For both kinds:

- `GET /api/mod/offers` -> `OffersResponse` (pending only).
- `POST /api/mod/offers/:id/accept` body `{}` -> `200 GameState`. Only the receiver
  (`403 forbidden` for the sender; `404` for others). Needs `status: "pending"`
  (`409 offer_not_pending { status }`). If the time control is live, both players are re-checked
  for an active live game: if either has one, `409 already_in_game { gameId }` and the offer stays
  pending. On success the game starts (9.6), the offer becomes `accepted` with `gameId`,
  `offer.cancelled { reason: "accepted" }` goes to both sides (so other clients close the offer),
  and both players get `match.found` with `via: "offer"` (lobby offer) or `"challenge"`.
- `POST /api/mod/offers/:id/decline` body `{}` -> `200 Offer`. By the receiver: status
  `declined`, reason `declined`. By the sender: status `cancelled`, reason `cancelled`.
  `offer.cancelled` to both sides. `409 offer_not_pending` if no longer pending.
- **Expiry**: 2 minutes after creation, status `expired`, `offer.cancelled { reason: "expired" }`
  to both sides.

```http
POST /api/mod/offers/of_31/accept
{}

200 {"id":"g_9x1","mode":"online","status":"active","timeControl":{"gameClock":null,"perMoveMs":86400000},"plyCount":0,"moveDeadlineAt":"2026-11-04T14:21:40.000Z", ... }
```

### 9.6 Game start and the active-game limit

- **Active-game limit**: a user may have at most **one active live game** (6.1: has a game clock,
  or `perMoveMs` <= 1 hour). Correspondence games are not limited. Lobby entries and pending
  offers do not count as games. While you have an active live game you cannot join the lobby
  (`409 already_in_game`).
- Whenever an online game starts (auto-match or offer accept), the server, in one transaction:
  re-checks the limit for both players if the new game is live (auto-match skips the pair; accept
  returns `409 already_in_game`); creates the game as `active`; removes the lobby entries of
  **both** players (for an offer/challenge accept each removed entry gets
  `match.cancelled { reason: "matched" }`; an auto-matched pair gets only `match.found`); cancels
  pending lobby offers to them (`unavailable`); gets or creates the pair chat thread and inserts a
  `game_started` system message (section 11); and emits `match.found` to both.
- `source` of the new game: the client of the accepting request (offer/challenge), or of the
  older lobby entry (auto-match).
- Computer games never count and never touch the lobby.

## 10. Endpoints: friends

`:id` in friend paths is always the **other user's id**.

```ts
interface FriendEntry extends UserRef {
  online: boolean;
  lastSeenAt: string | null;
  since: string; // when the friendship was accepted
}
interface FriendRequestEntry extends UserRef {
  at: string;    // request time
}
interface FriendsResponse {
  friends: FriendEntry[];         // accepted; online first, then by username
  incoming: FriendRequestEntry[]; // pending, they asked you
  outgoing: FriendRequestEntry[]; // pending, you asked them
}
```

- `GET /api/mod/friends` -> `FriendsResponse` (not paginated; max 500 friends).
- `POST /api/mod/friends/request` `{ username: string }` ->
  `200 { status: "pending" | "accepted"; user: UserRef }`. If that user already sent you a
  request, this accepts it (`"accepted"`, `friend.accepted` to both). Otherwise it emits
  `friend.request` to them. Errors: `404 not_found` (unknown user), `403 blocked` (either of you
  blocked the other), `409 conflict` (yourself, already friends, already requested).
- `POST /api/mod/friends/:id/accept` body `{}` -> `200 { friend: FriendEntry }`. Needs an incoming
  pending request from `:id` (`404` otherwise). Emits `friend.accepted` to both.
- `DELETE /api/mod/friends/:id` -> `200 { removed: true }`. Removes an accepted friendship,
  declines an incoming request, or cancels an outgoing one. Emits `friend.removed` to both users,
  except for a declined request, where only you get it (a decline is not announced). `404` if
  there is no relation.

Friendship is not required for chat, challenges or offers.

## 11. Endpoints: chat

There is exactly **one persistent thread per user pair**, created on first use (first message,
`POST /chat/dm`, or the first game between the two). The same thread is the chat panel on the game
page and the standalone conversation. Anyone can message anyone, unless either has blocked the
other (`403 blocked`; section 12). Only the two members can read a thread (`404 not_found`
otherwise).

Messages are either typed by a user (`kind: "user"`; trimmed, 1-500 chars, plain text; clients
render it as text, never as markup) or inserted by the server (`kind: "system"`) when a game
between the two starts or ends.

```ts
interface ChatSystemInfo {
  event: "game_started" | "game_ended";
  gameId: string;
  timeControl: TimeControl;
  result: GameResult | null; // game_ended only; null when aborted
  reason: GameReason | null; // game_ended only
}

interface ChatMessageInfo {
  id: string;
  threadId: string;
  kind: "user" | "system";
  sender: { userId: string; username: string } | null; // null for system
  text: string;                  // system: server-made English, e.g. "Game ended: 1-0 (checkmate)"
  system: ChatSystemInfo | null; // set for kind "system"
  at: string;
}

interface ChatThreadInfo {
  id: string;
  other: UserRef & { online: boolean }; // the other member
  lastMessage: ChatMessageInfo | null;
  unread: number;   // user messages from the other member after your lastReadAt
  canSend: boolean; // false when either of you blocked the other
}

interface ThreadsResponse { threads: ChatThreadInfo[]; nextCursor: string | null; }
interface MessagesResponse {
  messages: ChatMessageInfo[]; // oldest first within the page
  nextBefore: string | null;   // pass as ?before= for older messages; null = start of thread
}
```

- `GET /api/mod/chat/threads?limit=&cursor=` -> `ThreadsResponse`, latest activity first.
  Threads with a user **you** blocked are omitted. Threads without any message are omitted.
- `GET /api/mod/chat/threads/:id/messages?before=<messageId>&limit=` -> `MessagesResponse`.
  Without `before`: the newest `limit` messages (default 30, max 100). With `before`: the messages
  just older than that one. Reading does not mark anything read.
- `POST /api/mod/chat/threads/:id/messages` `{ text: string }` -> `201 ChatMessageInfo`. Emits
  `chat.message` to both members. `403 blocked` when either blocked the other. Sending also marks
  the thread read for you.
- `POST /api/mod/chat/threads/:id/read` `{ upTo?: string }` (a message id; default: newest) ->
  `200 { unread: number }`. Sets your `lastReadAt` to that message's time.
- `POST /api/mod/chat/dm` `{ username: string }` -> `200 ChatThreadInfo` (rate limit 30 / hour): gets or creates the
  pair thread with that user (works even when blocked, so the UI can show `canSend: false`;
  `404` unknown user, `400` yourself).

System messages: when an online game starts and when it ends (`finished` or `aborted`), the server
inserts a system message into the pair thread and emits `chat.message` to both members. They are
inserted even if one blocked the other (the thread stays hidden for the blocker).

```http
POST /api/mod/chat/threads/t_44/messages
{"text":"good luck!"}

201 {"id":"m_901","threadId":"t_44","kind":"user","sender":{"userId":"cm3u1","username":"luc"},"text":"good luck!","system":null,"at":"2026-11-03T14:00:12.000Z"}
```

```http
GET /api/mod/chat/threads/t_44/messages?limit=2

200 {"messages":[{"id":"m_900","threadId":"t_44","kind":"system","sender":null,"text":"Game started: 10+0","system":{"event":"game_started","gameId":"g_7k2","timeControl":{"gameClock":{"initialMs":600000,"incrementMs":0},"perMoveMs":null},"result":null,"reason":null},"at":"2026-11-03T14:00:00.000Z"},{"id":"m_901","threadId":"t_44","kind":"user","sender":{"userId":"cm3u1","username":"luc"},"text":"good luck!","system":null,"at":"2026-11-03T14:00:12.000Z"}],"nextBefore":"m_900"}
```

## 12. Endpoints: blocks

Blocking is about **messaging only**. A block by either user, in either direction, means:

- neither can send chat messages to the other (`403 blocked`),
- the pair thread is hidden from the **blocker** (not listed; still readable by id),
- friend requests between them are rejected (`403 blocked`), and blocking removes an existing
  friendship or pending request between them (`friend.removed` to the blocker only),
- offers and challenges **from** a user you blocked are hidden from you (no event, not listed)
  and expire on their own.

Blocks do **not** affect auto-match, the lobby list, or games in progress.

```ts
interface BlockEntry extends UserRef { at: string; }
interface BlocksResponse { blocks: BlockEntry[]; } // users you blocked, newest first
```

- `GET /api/mod/blocks` -> `BlocksResponse`.
- `POST /api/mod/blocks/:userId` body `{}` -> `200 { blocked: true }`. Idempotent. `404` unknown
  user, `400` yourself. No event to the blocked user.
- `DELETE /api/mod/blocks/:userId` -> `200 { blocked: false }`. Idempotent. The friendship is not
  restored.

## 13. Endpoints: offline import

Uploads finished offline games (mod vs computer, played without a connection) to the account.

### `POST /api/mod/offline/import`

```ts
interface ImportRequest { games: OfflineGame[] } // 1-50 games; OfflineGame is in section 17

interface ImportResult {
  clientId: string;
  status: "created" | "duplicate" | "invalid";
  gameId: string | null; // set for created and duplicate
  error?: string;        // for invalid, e.g. "illegal move at ply 14: e2e5"
}
interface ImportResponse { results: ImportResult[] } // same order as the request
```

Server behaviour:

- **Idempotent per user and `clientId`** (`Game.importedByUserId` + `Game.clientId`): a game
  already imported gives `duplicate` with the existing `gameId`; nothing changes.
- `moves` is replayed with chess.js from the standard start position and is authoritative. An
  illegal move makes the game `invalid`. The stored PGN is regenerated from the moves (the headers
  Event, Date, White, Black, Result are taken from the sent `pgn` when present).
- `result` must be `1-0`, `0-1` or `1/2-1/2` (unfinished games are never uploaded). If the final
  position is checkmate or stalemate, `result` and `reason` must match it (`invalid` otherwise).
  Other reasons (`resign`, `max_plies`, ...) are taken as given.
- Creates `Game { mode: "computer", source: "mod", status: "finished", timeControl: "-|-",
  engineLevel, result, reason }` with the user on `color` and the engine on the other side, plus
  `Move` rows (`at` = `playedAt`, `clockMs` null). Unrated. No events are emitted.
- An invalid game does not fail the batch. The request fails as a whole only for a malformed body
  (`400`) or more than 50 games (`413`).

The mod records `clientId -> result` (section 17.3) and never re-sends `created`, `duplicate` or
`invalid` games.

```http
POST /api/mod/offline/import
{"games":[{"clientId":"5d0f6c8e-3c1a-4c7e-9a51-0b8f0b6a2e11","playedAt":"2026-11-02T20:14:03.000Z","color":"white","engineLevel":4,"result":"1-0","reason":"checkmate","pgn":"[Event \"Terminal Games offline\"]\n...","moves":["e2e4","e7e5","d1h5","b8c6","f1c4","g8f6","h5f7"]}]}

200 {"results":[{"clientId":"5d0f6c8e-3c1a-4c7e-9a51-0b8f0b6a2e11","status":"created","gameId":"g_9q3"}]}
```

## 14. Events: long-poll

### 14.1 Model

All real-time changes are appended to one event log (`GameEvent`) with a single global, strictly
increasing `seq`. Each caller sees only the events visible to them (14.3). Both clients (mod
long-poll, browser SSE) read the same log with the same `since` semantics.

```ts
interface GameEventEnvelope<T extends EventType = EventType> {
  seq: number;
  type: T;
  at: string;              // ISO
  gameId: string | null;
  payload: EventPayloads[T]; // section 15
}
```

### 14.2 `GET /api/mod/events?since=<seq>&timeoutMs=<ms>`

- `since`: return events with `seq > since`. When omitted, the server returns
  `{ events: [], seq: <head>, ... }` at once (a starting point without `/me`).
- `timeoutMs`: how long to hold when nothing is new. Default 20000, clamped to 0-25000; `0` never
  holds.
- Returns **at once** when at least one visible event with `seq > since` exists; otherwise holds
  until one arrives or `timeoutMs` passes, then returns `{ events: [], seq, ... }`.
- At most 100 events per response, ascending by `seq`; `more: true` means call again at once.

```ts
interface EventsResponse {
  events: GameEventEnvelope[];
  seq: number;        // the `since` to use next
  more: boolean;
  serverTime: number;
}
```

`seq` in the response is the `seq` of the last returned event when `more` is true; otherwise it
is the log head the server checked, which can be larger than any event you can see (invisible
events are skipped). The client always continues with `since = response.seq` and never computes
it itself.

```http
GET /api/mod/events?since=48211&timeoutMs=20000

200 {"events":[{"seq":48215,"type":"game.move","at":"2026-11-03T14:00:09.000Z","gameId":"g_7k2","payload":{"gameId":"g_7k2","move":{"ply":2,"san":"e5","uci":"e7e5","fenAfter":"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2","clockMs":600000,"at":"2026-11-03T14:00:09.000Z"},"by":"black","fen":"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2","plyCount":2,"turn":"white","inCheck":false,"status":"active","drawOffer":null,"clock":{"initialMs":600000,"incrementMs":0,"whiteMs":600000,"blackMs":600000,"running":"white","serverTime":1793714709000},"moveDeadlineAt":null}}],"seq":48215,"more":false,"serverTime":1793714709050}
```

```http
GET /api/mod/events?since=48215&timeoutMs=20000
(held 20 s, nothing for this user)

200 {"events":[],"seq":48233,"more":false,"serverTime":1793714729060}
```

```http
GET /api/mod/events?since=120&timeoutMs=20000

410 {"error":"events_expired","message":"Event log no longer has seq 120; resync","seq":48233}
```

### 14.3 Visibility

The server only returns events visible to the caller:

- `game.*`: the caller is a player of `gameId` (one row per game event, `userId` null).
- `match.*`, `offer.*`, `friend.*`, `chat.message`, `chat.deleted`, `presence.changed`: the event row's `userId` is
  the caller. The server writes **one row per recipient** for these.

Rule for the server: a row with `userId` set is for that user only; a row with only `gameId` set
is for that game's players.

### 14.4 Ordering, gaps and resync

- Events come in `seq` order, and once the server has answered with `seq = N`, no event with
  `seq <= N` becomes visible later (section 19).
- A `GameState` carries `eventSeq`. After fetching a snapshot, the client MUST ignore events for
  that game with `seq <= snapshot.eventSeq` (already in the snapshot) and apply later ones.
- `game.move` carries the ply. If its `move.ply` is not the client's `plyCount + 1`, the client
  refetches `GET /api/mod/games/:id`.
- Retention: events are kept at least 24 h. If `since` is older than the oldest kept event, the
  server answers `410 { error: "events_expired", seq: <head> }`; the client resyncs (`/me`,
  active games, lobby, offers, friends, threads) and continues from that `seq`. The same 410
  is returned when `since` is newer than the head (e.g. a client state from another server or
  a reset database).

### 14.5 Mod polling rules

- Exactly one `/events` request in flight per install (token + `X-Client-Id`). Start the next one
  as soon as the previous returns (a `$.clock.every` tick, e.g. every 500 ms, starts one when none
  is in flight).
- Use `timeoutMs=20000`. An in-flight fetch is expected not to count against the hook time
  budget (to be verified in the mod runtime; if it does, lower `timeoutMs`, the server accepts any
  value 0-25000).
- Poll while signed in and the pane is open; this also keeps presence and the lobby entry alive.
  With the pane closed and no active online game, lobby entry or pending offer, polling MAY stop.
- Persist the last `seq` in `$.store` (`"events.seq"`) so a restart resumes without loss.

## 15. Event types and payloads

```ts
type EventType =
  | "game.move" | "game.over" | "game.draw_offer" | "game.draw_declined" | "game.clock"
  | "match.found" | "match.cancelled"
  | "offer.received" | "offer.cancelled"
  | "friend.request" | "friend.accepted" | "friend.removed"
  | "chat.message" | "chat.deleted" | "presence.changed";

interface EventPayloads {
  "game.move": GameMovePayload;
  "game.over": GameOverPayload;
  "game.draw_offer": { gameId: string; by: Color };
  "game.draw_declined": { gameId: string; by: Color };
  "game.clock": { gameId: string; clock: ClockState };
  "match.found": MatchFoundPayload;
  "match.cancelled": { reason: "left" | "stale" | "banned" | "replaced" | "matched" };
  "offer.received": { offer: Offer };
  "offer.cancelled": {
    offerId: string;
    reason: "declined" | "cancelled" | "expired" | "accepted" | "unavailable";
  };
  "friend.request": { from: UserRef };
  "friend.accepted": { user: UserRef };
  "friend.removed": { userId: string };
  "chat.message": { threadId: string; message: ChatMessageInfo };
  "chat.deleted": { threadId: string; messageId: string };
  "presence.changed": { userId: string; username: string; online: boolean; lastSeenAt: string };
}
```

### 15.1 `game.move`

Recipients: both players (the mover too, so the mover's other clients update).

```ts
interface GameMovePayload {
  gameId: string;
  move: MoveInfo;
  by: Color;
  fen: string;                   // = move.fenAfter
  plyCount: number;              // = move.ply
  turn: Color;
  inCheck: boolean;
  status: GameStatus;            // "finished" if this move ended the game (game.over follows)
  drawOffer: Color | null;       // pending offer after this move
  clock: ClockState | null;      // games with a game clock only
  moveDeadlineAt: string | null; // section 6.3
}
```

### 15.2 `game.over`

Recipients: both players. Emitted once, when `status` becomes `finished` or `aborted`
(checkmate, draw rules, resign, timeout, agreement, abort, abandoned).

```ts
interface GameOverPayload {
  gameId: string;
  status: "finished" | "aborted";
  result: GameResult | null;       // null when aborted
  reason: GameReason;
  ratingDeltaWhite: number | null; // null when unrated or aborted
  ratingDeltaBlack: number | null;
  whiteRating: number | null;      // new ratings after the game; null when unrated
  blackRating: number | null;
  clock: ClockState | null;        // final clocks, running: null
}
```

### 15.3 `game.draw_offer` and 15.4 `game.draw_declined`

Recipients: both players. `by` is the offering or declining side.

### 15.5 `game.clock` (optional heartbeat)

The server MAY emit this (e.g. every 10 s per active game with a game clock); v1 does not.
Clients MUST accept it (replace their clock state) and MUST NOT depend on it.

### 15.6 `match.found`

Recipient: each player of a game that just started (one row each).

```ts
interface MatchFoundPayload {
  gameId: string;
  color: Color;              // your color
  opponent: UserRef;
  timeControl: TimeControl;  // the chosen time control
  via: "queue" | "offer" | "challenge"; // queue = lobby auto-match
}
```

On receipt the client fetches `GET /api/mod/games/:gameId` and opens the board. The first moves
have deadlines (section 6.4).

### 15.7 `match.cancelled`

Recipient: the user whose lobby entry was removed: `left` (DELETE /queue), `stale` (no activity
for 60 s), `banned`, `replaced` (re-joined with other settings; a new entry exists), `matched` (a
game started through an offer or challenge; `match.found` is sent too).

### 15.8 `offer.received`

Recipient: the receiver of a lobby offer or challenge (not sent when the receiver blocked the
sender).

### 15.9 `offer.cancelled`

Recipients: sender and receiver (receiver only if the offer was not hidden). Sent whenever a
pending offer stops being pending: `declined` (by the receiver), `cancelled` (by the sender),
`expired` (2 min), `accepted` (`match.found` follows), `unavailable` (the receiver's lobby entry
was removed, or no longer accepts the offer's time control; lobby offers only).

### 15.10 `friend.request`, 15.11 `friend.accepted`, 15.12 `friend.removed`

Recipients as in sections 10 and 12. `friend.accepted` goes to both users, each with the **other**
user in `user`. `friend.removed` carries the other user's id.

### 15.13 `chat.message`

Recipients: both members of the pair thread, including the sender; for system messages both
players. Not sent to a member who blocked the other (the thread is hidden for them).

### 15.13a `chat.deleted`

Emitted when a message is deleted (by its sender or by a moderator). Payload
`{ threadId, messageId }`; the client removes that message from its view and recomputes the
thread's last message and unread count (refetch the thread list or `.../messages`). Recipients as
for `chat.message`: both members, except a member who blocked the other.

### 15.14 `presence.changed`

Recipients: the user's accepted friends. A user is **online** while `lastSeenAt` is within the
last 60 s. The server emits only transitions: offline -> online on the first request after being
offline, online -> offline from a sweep that runs at least every 15 s.

## 16. Browser equivalent: tRPC

The browser uses the same log, visibility rules and payloads, over a tRPC 11 SSE subscription
(`httpSubscriptionLink`):

```ts
// router: events.stream
stream: protectedOrGuestProcedure
  .input(z.object({ lastEventId: z.string().nullish() }))
  .subscription(async function* ({ ctx, input, signal }) {
    // 1. replay visible events with seq > Number(input.lastEventId), if given
    // 2. then wait for new ones (in-process wake-up + DB read) until `signal` aborts
    yield tracked(String(event.seq), event); // event: GameEventEnvelope
  });
```

- The tracked id **is** `seq` as a decimal string; on reconnect tRPC sends it back as
  `lastEventId`, which means exactly `since` in the long-poll.
- Without `lastEventId` the stream starts at the current head (no replay).
- Browser guests (signed `cgm_guest` cookie) get `game.*` events for their own guest games only.
- If `lastEventId` is older than the retention, the server yields one synthetic envelope
  `{ seq: <head>, type: "resync", at, gameId: null, payload: {} }` (browser only) and continues
  from the head; the browser refetches its views.
- Both transports are woken by the same server-side notifier (section 19), so an event reaches
  both at the same time.
- Every `/api/mod/*` endpoint has a tRPC procedure on the same service returning the same shape
  (e.g. `lobby.list` -> `LobbyResponse`, `lobby.join`, `lobby.offer`, `offers.accept`,
  `chat.threads`, `blocks.list`). Procedure names are up to the implementing team; shapes are
  not.

## 17. Offline game file format (mod)

### 17.1 One file per game

Location: `<modDataDir>/games/<YYYYMMDD-HHmmss>-<first 8 chars of clientId>.json`, using the UTC
time of `playedAt`. Written by the mod via `$.fs` when an offline game ends. Pretty-printed JSON
(2-space indent), UTF-8, readable by humans. `<modDataDir>` is the mod's data folder (the mod team
picks it and documents it in the mod README). Unfinished games stay in `$.store` as today, not in
files.

### 17.2 Shape (also the element of `ImportRequest.games`)

```ts
interface OfflineGame {
  clientId: string;    // UUID v4 made by the mod when the game starts; never reused
  playedAt: string;    // ISO, game start
  color: Color;        // the human's color
  engineLevel: number; // 1-10 (section 5)
  result: GameResult;  // finished games only
  reason: "checkmate" | "stalemate" | "insufficient_material" | "threefold" | "fifty_move"
        | "resign" | "max_plies";
  pgn: string;         // full PGN with headers Event, Site, Date, White, Black, Result
  moves: string[];     // UCI from the standard start position; authoritative over pgn
}
```

Example file `games/20261102-201403-5d0f6c8e.json`:

```json
{
  "clientId": "5d0f6c8e-3c1a-4c7e-9a51-0b8f0b6a2e11",
  "playedAt": "2026-11-02T20:14:03.000Z",
  "color": "white",
  "engineLevel": 4,
  "result": "1-0",
  "reason": "checkmate",
  "pgn": "[Event \"Terminal Games offline\"]\n[Site \"Claude Code\"]\n[Date \"2026.11.02\"]\n[White \"You\"]\n[Black \"Engine level 4\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
  "moves": ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"]
}
```

The file holds no account data and no token, so it stays valid across logins and accounts.

### 17.3 Upload bookkeeping

The mod keeps `$.store` key `"offline.uploaded"`:
`Record<clientId, { gameId: string | null; status: "created" | "duplicate" | "invalid"; at: string }>`.
Upload never modifies the files. On login (and on `/games sync`) the mod sends every file whose
`clientId` is not in that map, in batches of up to 50.

## 18. Mod client lifecycle (informative)

1. Startup: `GET /api/mod/version` (handle `426`). If `$.store["auth"]` exists and its
   `serverUrl` matches the setting: `GET /api/mod/me`; on `401` clear it.
2. Not signed in: offline play only. `/games login` runs section 4, then the offline import.
3. Signed in: start the long-poll from `$.store["events.seq"]` if present, else from
   `me.eventSeq` (on `410`, resync). Fetch each game in `activeGameIds`.
4. Lobby: `GET /api/mod/queue` every 5 s while the lobby view is open. Join with a rating range
   and accepted/preferred options (defaults: any range ±150, no game clock, 3 min/move). Pick a
   listed player and one of their accepted options to send an offer; incoming offers and
   challenges arrive as `offer.received`. Auto-matches and accepted offers arrive as
   `match.found`.
5. Play: send moves with `expectedPly`; show the move at once and roll back on `400`/`409`
   (refetch). Opponent moves arrive as `game.move`. Clocks and deadlines per section 6.
   Underpromotions (`a2a1r`) and server-declared draws come from the server and must be accepted.
6. Chat: the game view shows the pair thread (`chatThreadId`) including system lines; the chat
   view lists threads. New messages arrive as `chat.message`; call `.../read` when a thread is
   shown.
7. Friends and blocks: list endpoints when the view opens, then live updates from events.

## 19. Server implementation notes

Normative for the server teams; not visible to clients.

- **Route handlers**: `web/src/app/api/mod/**/route.ts` stay thin: auth (Better Auth
  `auth.api.getSession({ headers })` with the bearer plugin), version and `X-Client-Id` check,
  rate limit, zod validation, then the same service functions the tRPC routers call. One shared
  helper maps service errors to the codes in section 2.2. One shared module validates
  `TimeControl` / option sets and converts a `TimeControl` to and from the canonical key
  (section 6.1).
- **Ownership**: game-core owns version, me, games, lobby, offers/challenges, events and offline
  import; social owns friends, chat (including system messages, called by game-core on game
  start/end) and blocks; auth owns the device flow, the `/device` page, bearer config,
  `validateClient` and `POST /api/mod/logout`.
- **Seq ordering**: append events in the same transaction as the state change, and take a
  transaction-scoped lock (`SELECT pg_advisory_xact_lock(<constant>)`) before the insert, so
  commit order equals `seq` order. Without it a reader can see `seq` 11 committed before 10 and
  skip 10 forever.
- **Wake-up**: after commit, notify an in-process `EventEmitter` (plus Postgres `NOTIFY` if more
  than one instance ever runs). Held long-polls and SSE streams re-read the DB when woken, and
  every 2 s as a fallback. A held request must not hold a DB connection while it waits.
- **Snapshot `eventSeq`**: read the head `seq` in the same transaction as the game rows.
- **Matcher randomness**: use a cryptographically sound or seeded-per-test RNG behind one function
  so tests can fix the time-control and color picks.
- **Jobs**: one maintenance loop (every 1-2 s) for clock flags, per-move and first-move
  deadlines, the 7-day `abandoned` rule and offer expiry (sections 6.4, 9.5); the matcher every
  2 s; presence and lobby staleness every 15 s.
- **Schema changes vs the phase-0 schema** (game-core and social apply them in their branches):
  - `Game.timeControl` holds the canonical key; add `perMoveMs Int?` (or derive from the key) and
    an indexed `moveDeadlineAt DateTime?` maintained on every move for the deadline sweep.
    `challengerUserId` / `challengeExpiresAt` are no longer needed.
  - `QueueEntry`: drop `tier` and `timeControl`; add `rangeMin Int?`, `rangeMax Int?`,
    `gameClocks Json`, `perMove Json` (the two `OptionSet`s), `source String`.
  - New `Offer(id, kind, fromUserId, toUserId, timeControl, fromColor, status, createdAt,
    expiresAt, gameId?)`, indexes `(toUserId, status)`, `(status, expiresAt)`.
  - New `Block(blockerId, blockedId, createdAt)`, unique pair; `Friendship.status` no longer uses
    `"blocked"`.
  - `ChatThread`: `kind` becomes `"pair"`, drop `gameId`; add a unique `pairKey`
    (`"<smallerUserId>:<largerUserId>"`). `ChatMessage`: add `kind String @default("user")`,
    `senderId` nullable, `system Json?`.

## 20. Endpoint index

| Method | Path | Auth | Section |
|---|---|---|---|
| GET | `/api/mod/version` | none | 3 |
| POST | `/api/auth/device/code` | none | 4.1 |
| POST | `/api/auth/device/token` | none | 4.2 |
| POST | `/api/mod/logout` | bearer | 4.4 |
| GET | `/api/mod/me` | bearer | 7 |
| GET | `/api/mod/games` | bearer | 8 |
| POST | `/api/mod/games` | bearer | 8 (computer game or challenge) |
| GET | `/api/mod/games/:id` | bearer | 8 |
| POST | `/api/mod/games/:id/move` | bearer | 8 |
| POST | `/api/mod/games/:id/resign` | bearer | 8 |
| POST | `/api/mod/games/:id/draw` | bearer | 8 |
| GET | `/api/mod/queue` | bearer | 9.2 |
| POST | `/api/mod/queue` | bearer | 9.2 |
| DELETE | `/api/mod/queue` | bearer | 9.2 |
| POST | `/api/mod/queue/:userId/offer` | bearer | 9.4 |
| GET | `/api/mod/offers` | bearer | 9.5 |
| POST | `/api/mod/offers/:id/accept` | bearer | 9.5 |
| POST | `/api/mod/offers/:id/decline` | bearer | 9.5 |
| GET | `/api/mod/friends` | bearer | 10 |
| POST | `/api/mod/friends/request` | bearer | 10 |
| POST | `/api/mod/friends/:id/accept` | bearer | 10 |
| DELETE | `/api/mod/friends/:id` | bearer | 10 |
| GET | `/api/mod/chat/threads` | bearer | 11 |
| GET | `/api/mod/chat/threads/:id/messages` | bearer | 11 |
| POST | `/api/mod/chat/threads/:id/messages` | bearer | 11 |
| POST | `/api/mod/chat/threads/:id/read` | bearer | 11 |
| POST | `/api/mod/chat/dm` | bearer | 11 |
| GET | `/api/mod/blocks` | bearer | 12 |
| POST | `/api/mod/blocks/:userId` | bearer | 12 |
| DELETE | `/api/mod/blocks/:userId` | bearer | 12 |
| POST | `/api/mod/offline/import` | bearer | 13 |
| GET | `/api/mod/events` | bearer | 14 |
