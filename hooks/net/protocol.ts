// Wire types of the mod <-> server protocol (PROTOCOL.md, API v1, draft 4).
// That document is the contract: change it first, then these. Section
// numbers refer to it.

// 5. Shared types
export type Color = 'white' | 'black'
export type GameMode = 'online' | 'computer'
export type GameStatus = 'waiting' | 'active' | 'finished' | 'aborted'
export type GameResult = '1-0' | '0-1' | '1/2-1/2'
export type GameSource = 'web' | 'mod'

// 6. Time control: two independent dimensions; both null = unlimited.
export interface GameClock { initialMs: number; incrementMs: number }
export type GameClockOption = GameClock | null
export type PerMoveOption = number | null
export interface TimeControl { gameClock: GameClockOption; perMoveMs: PerMoveOption }

// null bound = open; { min: null, max: null } = any.
export interface RatingRange { min: number | null; max: number | null }

export type GameReason =
  | 'checkmate' | 'resign' | 'timeout' | 'abandoned'
  | 'stalemate' | 'insufficient_material' | 'threefold' | 'fifty_move' | 'agreement'
  | 'timeout_vs_insufficient' | 'max_plies'
  | 'aborted' | 'no_first_move'

export interface UserRef { userId: string; username: string; rating: number }

export interface PlayerInfo {
  kind: 'user' | 'guest' | 'engine'
  userId: string | null
  username: string | null
  rating: number | null
  online: boolean | null
}

export interface MoveInfo {
  ply: number
  san: string
  uci: string
  fenAfter: string
  clockMs: number | null
  at: string
}

export interface ClockState {
  initialMs: number
  incrementMs: number
  whiteMs: number
  blackMs: number
  running: Color | null
  serverTime: number
}

export interface GameSummary {
  id: string
  mode: GameMode
  source: GameSource
  timeControl: TimeControl
  engineLevel: number | null
  rated: boolean
  status: GameStatus
  result: GameResult | null
  reason: GameReason | null
  white: PlayerInfo
  black: PlayerInfo
  you: Color
  turn: Color
  fen: string
  plyCount: number
  lastMove: { uci: string; san: string } | null
  moveDeadlineAt: string | null
  ratingDeltaWhite: number | null
  ratingDeltaBlack: number | null
  createdAt: string
  lastMoveAt: string | null
}

export interface GameState extends GameSummary {
  pgn: string
  moves: MoveInfo[]
  clock: ClockState | null
  serverTime: number
  drawOffer: Color | null
  inCheck: boolean
  legalMoves: string[]
  canMove: boolean
  canResign: boolean
  canAbort: boolean
  canOfferDraw: boolean
  canAcceptDraw: boolean
  chatThreadId: string | null
  eventSeq: number
}

// 2. Errors
export type ErrorCode =
  | 'bad_request' | 'illegal_move' | 'not_supported'
  | 'unauthorized'
  | 'forbidden' | 'banned' | 'username_required' | 'blocked'
  | 'not_found'
  | 'not_your_turn' | 'stale_state' | 'game_not_active' | 'already_in_game'
  | 'draw_already_offered' | 'no_draw_offer' | 'not_queued' | 'offer_not_pending' | 'conflict'
  | 'events_expired'
  | 'payload_too_large'
  | 'upgrade_required'
  | 'rate_limited'
  | 'internal' | 'unavailable'

export interface ApiErrorBody {
  error: ErrorCode | string
  message: string
  [extra: string]: unknown
}

// 3. Versioning
export interface VersionResponse {
  apiVersion: 1
  minModVersion: string
  latestModVersion: string
  serverTime: number
}

// 4. Device flow (Better Auth, OAuth-shaped errors)
export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}
export interface DeviceTokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}
export interface OAuthErrorBody { error: string; error_description?: string }
export interface StoredAuth {
  serverUrl: string
  token: string
  userId: string
  username: string
  obtainedAt: string
}
export interface LogoutResponse { ok: true }

// 7. Account
export interface MeResponse {
  user: { id: string; username: string; rating: number; role: 'user' | 'admin'; createdAt: string }
  eventSeq: number
  activeGameIds: string[]
  queue: LobbyEntry | null
  serverTime: number
}

// 8. Games
export interface GamesListResponse { games: GameSummary[]; nextCursor: string | null }
export type CreateGameRequest =
  | { mode: 'computer'; engineLevel: number; color: Color | 'random' }
  | { mode: 'online'; opponentUsername: string; timeControl: TimeControl; color?: Color | 'random' }
export interface MoveRequest { uci: string; expectedPly?: number }
export interface MoveResponse { move: MoveInfo; game: GameState }
export type DrawAction = 'offer' | 'accept' | 'decline'

// 9. Lobby, auto-match, offers and challenges
export const MIN_RANGE = 50
export interface OptionSet<T> { accepted: T[]; preferred: T[] }
export interface LobbySettings {
  ratingRange: RatingRange
  gameClocks: OptionSet<GameClockOption>
  perMove: OptionSet<PerMoveOption>
}
export interface LobbyEntry extends LobbySettings {
  userId: string
  username: string
  rating: number
  since: string
}
export type QueueJoinRequest = Partial<LobbySettings>
export interface LobbyResponse { entries: LobbyEntry[]; you: LobbyEntry | null; serverTime: number }
export interface QueueLeaveResponse { left: boolean }
export type OfferKind = 'queue' | 'challenge'
export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'
export interface Offer {
  id: string
  kind: OfferKind
  from: UserRef
  to: UserRef
  timeControl: TimeControl
  fromColor: Color | 'random'
  status: OfferStatus
  createdAt: string
  expiresAt: string
  gameId: string | null
}
export interface OffersResponse { incoming: Offer[]; outgoing: Offer[] }
export interface LobbyOfferRequest { timeControl: TimeControl; color?: Color | 'random' }

// 10. Friends
export interface FriendEntry extends UserRef { online: boolean; lastSeenAt: string | null; since: string }
export interface FriendRequestEntry extends UserRef { at: string }
export interface FriendsResponse {
  friends: FriendEntry[]
  incoming: FriendRequestEntry[]
  outgoing: FriendRequestEntry[]
}
export interface FriendRequestResponse { status: 'pending' | 'accepted'; user: UserRef }

// 11. Chat: one thread per user pair
export interface ChatSystemInfo {
  event: 'game_started' | 'game_ended'
  gameId: string
  timeControl: TimeControl
  result: GameResult | null
  reason: GameReason | null
}
export interface ChatMessageInfo {
  id: string
  threadId: string
  kind: 'user' | 'system'
  sender: { userId: string; username: string } | null
  text: string
  system: ChatSystemInfo | null
  at: string
}
export interface ChatThreadInfo {
  id: string
  other: UserRef & { online: boolean }
  lastMessage: ChatMessageInfo | null
  unread: number
  canSend: boolean
}
export interface ThreadsResponse { threads: ChatThreadInfo[]; nextCursor: string | null }
export interface MessagesResponse { messages: ChatMessageInfo[]; nextBefore: string | null }

// 12. Blocks
export interface BlockEntry extends UserRef { at: string }
export interface BlocksResponse { blocks: BlockEntry[] }

// 13 + 17. Offline import
export type OfflineReason =
  | 'checkmate' | 'stalemate' | 'insufficient_material' | 'threefold' | 'fifty_move'
  | 'resign' | 'max_plies'
export interface OfflineGame {
  clientId: string
  playedAt: string
  color: Color
  engineLevel: number
  result: GameResult
  reason: OfflineReason
  pgn: string
  moves: string[]
}
export interface ImportResult {
  clientId: string
  status: 'created' | 'duplicate' | 'invalid'
  gameId: string | null
  error?: string
}
export interface ImportResponse { results: ImportResult[] }

// 14 + 15. Events
export type EventType =
  | 'game.move' | 'game.over' | 'game.draw_offer' | 'game.draw_declined' | 'game.clock'
  | 'match.found' | 'match.cancelled'
  | 'offer.received' | 'offer.cancelled'
  | 'friend.request' | 'friend.accepted' | 'friend.removed'
  | 'chat.message' | 'presence.changed'

export interface GameMovePayload {
  gameId: string
  move: MoveInfo
  by: Color
  fen: string
  plyCount: number
  turn: Color
  inCheck: boolean
  status: GameStatus
  drawOffer: Color | null
  clock: ClockState | null
  moveDeadlineAt: string | null
}
export interface GameOverPayload {
  gameId: string
  status: 'finished' | 'aborted'
  result: GameResult | null
  reason: GameReason
  ratingDeltaWhite: number | null
  ratingDeltaBlack: number | null
  whiteRating: number | null
  blackRating: number | null
  clock: ClockState | null
}
export interface MatchFoundPayload {
  gameId: string
  color: Color
  opponent: UserRef
  timeControl: TimeControl
  via: 'queue' | 'offer' | 'challenge'
}
export type MatchCancelReason = 'left' | 'stale' | 'banned' | 'replaced' | 'matched'
export type OfferCancelReason = 'declined' | 'cancelled' | 'expired' | 'accepted' | 'unavailable'

export interface EventPayloads {
  'game.move': GameMovePayload
  'game.over': GameOverPayload
  'game.draw_offer': { gameId: string; by: Color }
  'game.draw_declined': { gameId: string; by: Color }
  'game.clock': { gameId: string; clock: ClockState }
  'match.found': MatchFoundPayload
  'match.cancelled': { reason: MatchCancelReason }
  'offer.received': { offer: Offer }
  'offer.cancelled': { offerId: string; reason: OfferCancelReason }
  'friend.request': { from: UserRef }
  'friend.accepted': { user: UserRef }
  'friend.removed': { userId: string }
  'chat.message': { threadId: string; message: ChatMessageInfo }
  'presence.changed': { userId: string; username: string; online: boolean; lastSeenAt: string }
}

export interface GameEventEnvelope<T extends EventType = EventType> {
  seq: number
  type: T
  at: string
  gameId: string | null
  payload: EventPayloads[T]
}

export interface EventsResponse {
  events: GameEventEnvelope[]
  seq: number
  more: boolean
  serverTime: number
}
