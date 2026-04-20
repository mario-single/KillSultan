import {
  ActionRevealPayload,
  GameState,
  PlayerScopedState,
  PlayerState,
  PublicGameView,
  WinFaction,
  buildPlayerScopedState,
  buildPublicState,
} from "@sultan/shared";
import { v4 as uuid } from "uuid";

import { CoreRulesBridge } from "./core-rules-bridge.js";
import { GameError } from "./game-error.js";
import { createCard, defaultSettings } from "./setup.js";
import { StateStore } from "../store/state-store.js";

interface ActiveRoom {
  state: GameState;
  socketByPlayerId: Map<string, string>;
  playerBySocketId: Map<string, string>;
}

export interface RoomJoinResult {
  roomId: string;
  playerId: string;
  token: string;
}

export interface EngineMutationResult {
  scopedState: PlayerScopedState;
  publicState: PublicGameView;
  privateNotice?: {
    message: string;
    detail?: unknown;
  };
}

export { GameError } from "./game-error.js";

export class GameEngine {
  private readonly rooms = new Map<string, ActiveRoom>();
  private readonly socketIndex = new Map<string, { roomId: string; playerId: string }>();
  private readonly coreRules = new CoreRulesBridge();

  constructor(private readonly stateStore: StateStore) {}

  async createRoom(playerName: string, socketId: string, token?: string): Promise<RoomJoinResult> {
    this.assertValidName(playerName);
    const roomId = this.generateRoomId();
    const playerId = uuid();
    const playerToken = token ?? uuid();
    const now = Date.now();

    const state: GameState = {
      roomId,
      hostPlayerId: playerId,
      phase: "lobby",
      createdAt: now,
      updatedAt: now,
      settings: defaultSettings(),
      players: {
        [playerId]: {
          id: playerId,
          token: playerToken,
          name: playerName.trim(),
          seatIndex: 0,
          connected: true,
          ready: false,
          alive: true,
          skipActions: 0,
          card: createCard("oracle", 0),
          privateKnowledge: [],
        },
      },
      seatOrder: [playerId],
      centerCard: createCard("guard", 0),
      turn: { currentSeatIndex: 0, round: 1, sequence: 1 },
      effects: {},
      logs: [],
    };

    this.addLog(state, "system", `${playerName} 创建了房间 ${roomId}`, playerId);

    const room: ActiveRoom = {
      state,
      socketByPlayerId: new Map(),
      playerBySocketId: new Map(),
    };
    this.rooms.set(roomId, room);
    this.attachSocket(room, playerId, socketId);
    await this.persist(room);
    return { roomId, playerId, token: playerToken };
  }

  async joinRoom(
    roomId: string,
    playerName: string,
    socketId: string,
    token?: string,
  ): Promise<RoomJoinResult> {
    this.assertValidName(playerName);
    const room = await this.getRoomOrThrow(roomId);
    const { state } = room;

    const existsByToken = token
      ? Object.values(state.players).find((candidate) => candidate.token === token)
      : undefined;
    if (existsByToken) {
      existsByToken.connected = true;
      this.attachSocket(room, existsByToken.id, socketId);
      this.markUpdated(state);
      await this.persist(room);
      return { roomId, playerId: existsByToken.id, token: existsByToken.token };
    }

    if (state.phase !== "lobby") {
      throw new GameError("ROOM_ALREADY_STARTED", "游戏已开始，仅支持原玩家重连。");
    }
    if (state.seatOrder.length >= state.settings.maxPlayers) {
      throw new GameError("ROOM_FULL", "房间人数已满。");
    }

    const playerId = uuid();
    const playerToken = token ?? uuid();
    state.players[playerId] = {
      id: playerId,
      token: playerToken,
      name: playerName.trim(),
      seatIndex: state.seatOrder.length,
      connected: true,
      ready: false,
      alive: true,
      skipActions: 0,
      card: createCard("oracle", 0),
      privateKnowledge: [],
    };
    state.seatOrder.push(playerId);

    this.attachSocket(room, playerId, socketId);
    this.addLog(state, "system", `${playerName} 加入了房间`, playerId);
    this.markUpdated(state);
    await this.persist(room);

    return { roomId, playerId, token: playerToken };
  }

  async resyncByToken(roomId: string, token: string, socketId: string): Promise<PlayerScopedState> {
    const room = await this.getRoomOrThrow(roomId);
    const player = Object.values(room.state.players).find((candidate) => candidate.token === token);
    if (!player) {
      throw new GameError("RESYNC_NOT_FOUND", "该房间中不存在匹配的玩家凭证。");
    }
    player.connected = true;
    this.attachSocket(room, player.id, socketId);
    this.markUpdated(room.state);
    await this.persist(room);
    return this.getScopedState(roomId, player.id);
  }

  async leaveRoom(roomId: string, socketId: string): Promise<PublicGameView> {
    const room = await this.getRoomOrThrow(roomId);
    const playerId = this.resolvePlayerId(room, socketId);
    const player = this.getPlayerOrThrow(room.state, playerId);

    if (room.state.phase === "lobby") {
      delete room.state.players[playerId];
      room.state.seatOrder = room.state.seatOrder.filter((id) => id !== playerId);
      room.state.seatOrder.forEach((id, index) => {
        room.state.players[id].seatIndex = index;
      });
      if (room.state.hostPlayerId === playerId && room.state.seatOrder.length > 0) {
        room.state.hostPlayerId = room.state.seatOrder[0];
      }
      this.detachSocket(room, socketId);
      this.addLog(room.state, "system", `${player.name} 离开了房间`, playerId);

      if (room.state.seatOrder.length === 0) {
        this.rooms.delete(roomId);
        await this.stateStore.delete(roomId);
        return {
          roomId,
          phase: "lobby",
          hostPlayerId: "",
          settings: defaultSettings(),
          players: [],
          seatOrder: [],
          centerCardCount: 1,
          turn: { currentSeatIndex: 0, round: 1, sequence: 1 },
          logs: [],
        };
      }
    } else {
      room.state = (await this.coreRules.disconnect(room.state, playerId)).state;
      this.detachSocket(room, socketId);
    }

    this.markUpdated(room.state);
    await this.persist(room);
    return buildPublicState(room.state);
  }

  async setReady(roomId: string, socketId: string, ready: boolean): Promise<PublicGameView> {
    const room = await this.getRoomOrThrow(roomId);
    const playerId = this.resolvePlayerId(room, socketId);
    if (room.state.phase !== "lobby") {
      throw new GameError("GAME_ALREADY_STARTED", "游戏开始后不能再切换准备状态。");
    }
    room.state.players[playerId].ready = ready;
    this.addLog(room.state, "system", `${room.state.players[playerId].name} ${ready ? "已准备" : "取消准备"}`);
    this.markUpdated(room.state);
    await this.persist(room);
    return buildPublicState(room.state);
  }

  async startGame(roomId: string, socketId: string): Promise<PublicGameView> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    room.state = (await this.coreRules.startGame(room.state, actorId)).state;
    this.markUpdated(room.state);
    await this.persist(room);
    return buildPublicState(room.state);
  }

  async handlePlayerPeek(
    roomId: string,
    socketId: string,
    targetPlayerId: string,
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionPeek(room.state, actorId, targetPlayerId);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async handlePlayerSwap(
    roomId: string,
    socketId: string,
    targetPlayerId: string,
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionSwap(room.state, actorId, targetPlayerId);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async handlePlayerSwapWithCenter(roomId: string, socketId: string): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionSwapCenter(room.state, actorId);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async handlePlayerReveal(
    roomId: string,
    socketId: string,
    payload: ActionRevealPayload,
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionReveal(room.state, actorId, payload);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async handleDeclineSlaveUprisingFollow(roomId: string, socketId: string): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionDeclineFollow(room.state, actorId);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async handleOraclePrediction(
    roomId: string,
    socketId: string,
    prediction: WinFaction,
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionOraclePrediction(room.state, actorId, prediction);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async handleEndTurn(roomId: string, socketId: string): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionEndTurn(room.state, actorId);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async handleSlaveTraderPick(
    roomId: string,
    socketId: string,
    targetPlayerId: string,
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const result = await this.coreRules.actionSlaveTraderPick(room.state, actorId, targetPlayerId);
    room.state = result.state;
    this.markUpdated(room.state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(room.state, actorId),
      publicState: buildPublicState(room.state),
      privateNotice: result.privateNotice,
    };
  }

  async disconnectSocket(socketId: string): Promise<{ roomId?: string }> {
    const location = this.socketIndex.get(socketId);
    if (!location) {
      return {};
    }
    const room = this.rooms.get(location.roomId);
    if (!room) {
      this.socketIndex.delete(socketId);
      return {};
    }

    if (room.state.phase === "in_game") {
      room.state = (await this.coreRules.disconnect(room.state, location.playerId)).state;
      this.markUpdated(room.state);
      await this.persist(room);
    } else {
      const player = room.state.players[location.playerId];
      if (player) {
        player.connected = false;
        this.addLog(room.state, "system", `${player.name} 断开连接`, player.id);
        this.markUpdated(room.state);
        await this.persist(room);
      }
    }

    this.detachSocket(room, socketId);
    return { roomId: location.roomId };
  }

  async getPublicState(roomId: string): Promise<PublicGameView> {
    const room = await this.getRoomOrThrow(roomId);
    return buildPublicState(room.state);
  }

  async getScopedStateBySocket(roomId: string, socketId: string): Promise<PlayerScopedState> {
    const room = await this.getRoomOrThrow(roomId);
    const playerId = this.resolvePlayerId(room, socketId);
    return buildPlayerScopedState(room.state, playerId);
  }

  getSocketTargets(roomId: string): Array<{ playerId: string; socketId: string }> {
    const room = this.rooms.get(roomId);
    if (!room) {
      return [];
    }
    return Array.from(room.socketByPlayerId.entries()).map(([playerId, socketId]) => ({
      playerId,
      socketId,
    }));
  }

  getScopedState(roomId: string, playerId: string): PlayerScopedState {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new GameError("ROOM_NOT_FOUND", "房间不存在。");
    }
    return buildPlayerScopedState(room.state, playerId);
  }

  private async getRoomOrThrow(roomId: string): Promise<ActiveRoom> {
    const cached = this.rooms.get(roomId);
    if (cached) {
      return cached;
    }

    const loaded = await this.stateStore.load(roomId);
    if (!loaded) {
      throw new GameError("ROOM_NOT_FOUND", "房间不存在。");
    }

    const room: ActiveRoom = {
      state: loaded,
      socketByPlayerId: new Map(),
      playerBySocketId: new Map(),
    };
    this.rooms.set(roomId, room);
    return room;
  }

  private resolvePlayerId(room: ActiveRoom, socketId: string): string {
    const playerId = room.playerBySocketId.get(socketId);
    if (!playerId) {
      throw new GameError("NOT_IN_ROOM", "当前连接不在该房间内。");
    }
    return playerId;
  }

  private getPlayerOrThrow(state: GameState, playerId: string): PlayerState {
    const player = state.players[playerId];
    if (!player) {
      throw new GameError("PLAYER_NOT_FOUND", "玩家不存在。");
    }
    return player;
  }

  private attachSocket(room: ActiveRoom, playerId: string, socketId: string): void {
    const prevSocket = room.socketByPlayerId.get(playerId);
    if (prevSocket) {
      room.playerBySocketId.delete(prevSocket);
      this.socketIndex.delete(prevSocket);
    }
    const existing = this.socketIndex.get(socketId);
    if (existing) {
      const prevRoom = this.rooms.get(existing.roomId);
      if (prevRoom) {
        prevRoom.socketByPlayerId.delete(existing.playerId);
        prevRoom.playerBySocketId.delete(socketId);
      }
    }
    room.socketByPlayerId.set(playerId, socketId);
    room.playerBySocketId.set(socketId, playerId);
    this.socketIndex.set(socketId, { roomId: room.state.roomId, playerId });
  }

  private detachSocket(room: ActiveRoom, socketId: string): void {
    const playerId = room.playerBySocketId.get(socketId);
    if (playerId) {
      room.socketByPlayerId.delete(playerId);
    }
    room.playerBySocketId.delete(socketId);
    this.socketIndex.delete(socketId);
  }

  private generateRoomId(): string {
    let roomId = "";
    do {
      roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    } while (this.rooms.has(roomId));
    return roomId;
  }

  private assertValidName(name: string): void {
    if (!name || !name.trim()) {
      throw new GameError("INVALID_NAME", "玩家昵称不能为空。");
    }
    if (name.trim().length > 24) {
      throw new GameError("INVALID_NAME", "玩家昵称过长（最多 24 个字符）。");
    }
  }

  private addLog(
    state: GameState,
    type: GameState["logs"][number]["type"],
    message: string,
    actorId?: string,
    targetId?: string,
  ): void {
    state.logs.push({
      id: uuid(),
      turnSequence: state.turn.sequence,
      at: Date.now(),
      type,
      message,
      actorId,
      targetId,
    });
    if (state.logs.length > 500) {
      state.logs = state.logs.slice(-500);
    }
  }

  private markUpdated(state: GameState): void {
    state.updatedAt = Date.now();
  }

  private async persist(room: ActiveRoom): Promise<void> {
    await this.stateStore.save(room.state);
  }
}
