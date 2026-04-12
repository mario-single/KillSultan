export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 15;

export type RoomPhase = "lobby" | "in_game" | "finished";
export type WinFaction = "rebels" | "loyalists";
export type ActionType = "peek" | "swap" | "reveal" | "swap_center";

export type Role =
  | "sultan"
  | "assassin"
  | "guard"
  | "slave"
  | "oracle"
  | "belly_dancer"
  | "slave_trader"
  | "grand_official";

export interface CardState {
  role: Role;
  faceUp: boolean;
  version: number;
}

export interface KnowledgeItem {
  subjectType: "player" | "center";
  subjectId: string;
  role: Role;
  observedVersion: number;
  source: "peek" | "oracle";
  turnSequence: number;
}

export interface PlayerState {
  id: string;
  token: string;
  name: string;
  seatIndex: number;
  connected: boolean;
  ready: boolean;
  alive: boolean;
  skipActions: number;
  card: CardState;
  oraclePrediction?: WinFaction;
  privateKnowledge: KnowledgeItem[];
}

export interface LogEntry {
  id: string;
  turnSequence: number;
  at: number;
  type:
    | "system"
    | "peek"
    | "swap"
    | "swap_center"
    | "reveal"
    | "skill"
    | "death"
    | "detain"
    | "turn"
    | "win";
  message: string;
  actorId?: string;
  targetId?: string;
}

export interface TurnState {
  currentSeatIndex: number;
  round: number;
  sequence: number;
}

export interface GameSettings {
  minPlayers: number;
  maxPlayers: number;
  revealLogLimit: number;
}

export interface GameEffects {
  sultanCrownedRound?: number;
  sultanCrownedSequence?: number;
  sultanPlayerId?: string;
  crownedByPlayerId?: string;
  sultanKilledByAssassin?: boolean;
  assassinKillerPlayerId?: string;
  extraTurnPlayerId?: string;
  noSwapBackA?: string;
  noSwapBackB?: string;
  noSwapBackSequence?: number;
  pendingSlaveUprising?: {
    initiatorPlayerId: string;
    currentResponderId: string;
    queue: string[];
    resolvedPlayerIds: string[];
  };
}

export interface WinResult {
  winnerFaction: WinFaction;
  winners: string[];
  reason: string;
  scoreByPlayerId?: Record<string, number>;
  endedAt: number;
}

export interface GameState {
  roomId: string;
  hostPlayerId: string;
  phase: RoomPhase;
  createdAt: number;
  updatedAt: number;
  settings: GameSettings;
  players: Record<string, PlayerState>;
  seatOrder: string[];
  centerCard: CardState;
  turn: TurnState;
  effects: GameEffects;
  logs: LogEntry[];
  winner?: WinResult;
}

export interface PublicPlayerView {
  id: string;
  name: string;
  seatIndex: number;
  connected: boolean;
  ready: boolean;
  alive: boolean;
  skipActions: number;
  cardFaceUp: boolean;
  revealedRole?: Role;
}

export interface PublicGameView {
  roomId: string;
  phase: RoomPhase;
  hostPlayerId: string;
  settings: GameSettings;
  players: PublicPlayerView[];
  seatOrder: string[];
  centerCardCount: 1;
  turn: TurnState;
  currentPlayerId?: string;
  pendingAction?: {
    kind: "slave_uprising";
    initiatorPlayerId: string;
    responderPlayerId: string;
  };
  logs: LogEntry[];
  winner?: WinResult;
}

export interface PrivateGameView {
  selfPlayerId: string;
  selfRole?: Role;
  selfCardFaceUp: boolean;
  centerCardKnownRole?: Role;
  privateKnowledge: KnowledgeItem[];
  oraclePrediction?: WinFaction;
}

export interface PlayerScopedState {
  publicState: PublicGameView;
  privateState: PrivateGameView;
}

export interface ActionRevealPayload {
  targetPlayerId?: string;
  followerIds?: string[];
  slaveTraderTargets?: string[];
  oraclePrediction?: WinFaction;
  inspectSubjects?: Array<
    | { subjectType: "player"; subjectId: string }
    | { subjectType: "center"; subjectId: "center" }
  >;
  forceSkill?: {
    targetPlayerId?: string;
    followerIds?: string[];
    slaveTraderTargets?: string[];
    oraclePrediction?: WinFaction;
    inspectSubjects?: Array<
      | { subjectType: "player"; subjectId: string }
      | { subjectType: "center"; subjectId: "center" }
    >;
  };
}

export interface ServerActionPayloadMap {
  peek: { targetPlayerId: string };
  swap: { targetPlayerId: string };
  reveal: ActionRevealPayload;
  swap_center: Record<string, never>;
}
