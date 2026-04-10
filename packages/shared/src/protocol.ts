import {
  ActionRevealPayload,
  PlayerScopedState,
  PublicGameView,
  WinFaction,
} from "./game-types.js";

export interface AckSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface AckFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type AckResult<T = unknown> = AckSuccess<T> | AckFailure;

export interface RoomCreatePayload {
  playerName: string;
  token?: string;
}

export interface RoomJoinPayload {
  roomId: string;
  playerName: string;
  token?: string;
}

export interface RoomLeavePayload {
  roomId: string;
}

export interface ReadyPayload {
  roomId: string;
  ready: boolean;
}

export interface StartGamePayload {
  roomId: string;
}

export interface ActionPeekPayload {
  roomId: string;
  targetPlayerId: string;
}

export interface ActionSwapPayload {
  roomId: string;
  targetPlayerId: string;
}

export interface ActionSwapCenterPayload {
  roomId: string;
}

export interface ActionRevealSocketPayload extends ActionRevealPayload {
  roomId: string;
}

export interface SelectOraclePredictionPayload {
  roomId: string;
  prediction: WinFaction;
}

export interface ResyncPayload {
  roomId: string;
  token: string;
}

export interface RoomCreatedData {
  roomId: string;
  playerId: string;
  token: string;
}

export interface RoomJoinedData {
  roomId: string;
  playerId: string;
  token: string;
}

export interface ClientToServerEvents {
  "room:create": (
    payload: RoomCreatePayload,
    ack: (result: AckResult<RoomCreatedData>) => void,
  ) => void;
  "room:join": (
    payload: RoomJoinPayload,
    ack: (result: AckResult<RoomJoinedData>) => void,
  ) => void;
  "room:leave": (
    payload: RoomLeavePayload,
    ack: (result: AckResult<PublicGameView>) => void,
  ) => void;
  "room:ready": (
    payload: ReadyPayload,
    ack: (result: AckResult<PublicGameView>) => void,
  ) => void;
  "game:start": (
    payload: StartGamePayload,
    ack: (result: AckResult<PublicGameView>) => void,
  ) => void;
  "action:peek": (
    payload: ActionPeekPayload,
    ack: (result: AckResult<PlayerScopedState>) => void,
  ) => void;
  "action:swap": (
    payload: ActionSwapPayload,
    ack: (result: AckResult<PlayerScopedState>) => void,
  ) => void;
  "action:swapCenter": (
    payload: ActionSwapCenterPayload,
    ack: (result: AckResult<PlayerScopedState>) => void,
  ) => void;
  "action:reveal": (
    payload: ActionRevealSocketPayload,
    ack: (result: AckResult<PlayerScopedState>) => void,
  ) => void;
  "state:resync": (
    payload: ResyncPayload,
    ack: (result: AckResult<PlayerScopedState>) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "room:update": (state: PublicGameView) => void;
  "game:state": (state: PlayerScopedState) => void;
  "game:private": (payload: { message: string; detail?: unknown }) => void;
  "game:over": (state: PlayerScopedState) => void;
  "game:error": (payload: { code: string; message: string }) => void;
}
