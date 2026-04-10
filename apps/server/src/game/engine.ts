import {
  GameState,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PlayerScopedState,
  PlayerState,
  PublicGameView,
  Role,
  WinFaction,
  buildPlayerScopedState,
  buildPublicState,
  circularAdjacentSeatIndices,
  countCircularMaxRun,
  effectiveFaction,
} from "@sultan/shared";
import { v4 as uuid } from "uuid";

import { defaultSettings, buildDeck, createCard } from "./setup.js";
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

export class GameError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ROLE_NAME_ZH: Record<Role, string> = {
  sultan: "苏丹",
  assassin: "刺客",
  guard: "守卫",
  slave: "奴隶",
  oracle: "占卜师",
  belly_dancer: "肚皮舞娘",
};

function roleNameZh(role: Role): string {
  return ROLE_NAME_ZH[role] ?? role;
}

function factionNameZh(faction: WinFaction): string {
  return faction === "rebels" ? "革命党" : "保皇派";
}

function actionNameZh(action: string): string {
  switch (action) {
    case "peek":
      return "偷看";
    case "swap":
      return "交换";
    case "swap_center":
      return "换中间牌";
    case "reveal":
      return "公开";
    default:
      return action;
  }
}

export class GameEngine {
  private readonly rooms = new Map<string, ActiveRoom>();
  private readonly socketIndex = new Map<string, { roomId: string; playerId: string }>();

  constructor(private readonly stateStore: StateStore) {}

  async createRoom(
    playerName: string,
    socketId: string,
    token?: string,
  ): Promise<RoomJoinResult> {
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
      turn: {
        currentSeatIndex: 0,
        round: 1,
        sequence: 1,
      },
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

    return {
      roomId,
      playerId,
      token: playerToken,
    };
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

    let player = token
      ? Object.values(state.players).find((candidate) => candidate.token === token)
      : undefined;

    if (player) {
      player.connected = true;
      this.attachSocket(room, player.id, socketId);
      this.markUpdated(state);
      await this.persist(room);
      return { roomId, playerId: player.id, token: player.token };
    }

    if (state.phase !== "lobby") {
      throw new GameError("ROOM_ALREADY_STARTED", "游戏已开始，仅支持原玩家重连。");
    }

    if (state.seatOrder.length >= state.settings.maxPlayers) {
      throw new GameError("ROOM_FULL", "房间人数已满。");
    }

    const playerId = uuid();
    const playerToken = token ?? uuid();
    player = {
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
    state.players[playerId] = player;
    state.seatOrder.push(playerId);
    this.attachSocket(room, playerId, socketId);
    this.addLog(state, "system", `${player.name} 加入了房间`, playerId);
    this.markUpdated(state);
    await this.persist(room);

    return {
      roomId,
      playerId,
      token: playerToken,
    };
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
      player.connected = false;
      this.detachSocket(room, socketId);
      this.addLog(room.state, "system", `${player.name} 断开连接`, playerId);
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
    this.addLog(
      room.state,
      "system",
      `${room.state.players[playerId].name} ${ready ? "已准备" : "取消准备"}`,
      playerId,
    );
    this.markUpdated(room.state);
    await this.persist(room);
    return buildPublicState(room.state);
  }

  async startGame(roomId: string, socketId: string): Promise<PublicGameView> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const { state } = room;

    if (state.phase !== "lobby") {
      throw new GameError("GAME_ALREADY_STARTED", "游戏已经开始。");
    }
    if (state.hostPlayerId !== actorId) {
      throw new GameError("NOT_HOST", "只有房主可以开始游戏。");
    }
    if (state.seatOrder.length < MIN_PLAYERS || state.seatOrder.length > MAX_PLAYERS) {
      throw new GameError(
        "INVALID_PLAYER_COUNT",
        `玩家人数必须在 ${MIN_PLAYERS} 到 ${MAX_PLAYERS} 之间。`,
      );
    }
    const unreadyPlayer = state.seatOrder.find((id) => !state.players[id].ready);
    if (unreadyPlayer) {
      throw new GameError("PLAYERS_NOT_READY", "开始前需要所有玩家都准备。");
    }

    const deck = buildDeck(state.seatOrder.length);
    state.seatOrder.forEach((playerId, idx) => {
      const player = state.players[playerId];
      player.card = createCard(deck[idx], 1);
      player.alive = true;
      player.skipActions = 0;
      player.privateKnowledge = [];
      player.oraclePrediction = undefined;
    });
    state.centerCard = createCard(deck[deck.length - 1], 1);
    state.turn = { currentSeatIndex: 0, round: 1, sequence: 1 };
    state.phase = "in_game";
    state.winner = undefined;
    state.effects = {};
    this.addLog(state, "system", "游戏开始，身份已发放。");
    this.addLog(
      state,
      "turn",
      `第 ${state.turn.round} 轮，轮到 ${state.players[this.currentPlayerId(state)].name} 行动。`,
    );
    this.markUpdated(state);
    await this.persist(room);
    return buildPublicState(state);
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
    const player = room.state.players[location.playerId];
    if (player) {
      player.connected = false;
      this.addLog(room.state, "system", `${player.name} 断开连接`, player.id);
      this.markUpdated(room.state);
      await this.persist(room);
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

  async handlePlayerPeek(
    roomId: string,
    socketId: string,
    targetPlayerId: string,
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const state = room.state;
    this.assertActionTurn(state, actorId, "peek");

    const actor = this.getPlayerOrThrow(state, actorId);
    const target = this.getPlayerOrThrow(state, targetPlayerId);
    if (!target.alive) {
      throw new GameError("TARGET_DEAD", "不能偷看已死亡玩家。");
    }
    if (actor.id === target.id) {
      throw new GameError("INVALID_TARGET", "不能偷看自己。");
    }

    actor.privateKnowledge.push({
      subjectType: "player",
      subjectId: target.id,
      role: target.card.role,
      observedVersion: target.card.version,
      source: "peek",
      turnSequence: state.turn.sequence,
    });
    this.trimKnowledge(actor);

    this.addLog(state, "peek", `${actor.name} 偷看了 ${target.name} 的身份`, actor.id, target.id);
    const privateNotice = {
      message: `偷看结果：${target.name} 的身份是 ${roleNameZh(target.card.role)}。`,
      detail: { targetPlayerId: target.id, role: target.card.role, roleNameZh: roleNameZh(target.card.role) },
    };

    this.finishActionAndAdvance(state);
    this.markUpdated(state);
    await this.persist(room);

    return {
      scopedState: buildPlayerScopedState(state, actor.id),
      publicState: buildPublicState(state),
      privateNotice,
    };
  }

  async handlePlayerSwap(
    roomId: string,
    socketId: string,
    targetPlayerId: string,
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const state = room.state;
    this.assertActionTurn(state, actorId, "swap");

    const actor = this.getPlayerOrThrow(state, actorId);
    const target = this.getPlayerOrThrow(state, targetPlayerId);
    if (!target.alive) {
      throw new GameError("TARGET_DEAD", "不能与已死亡玩家交换。");
    }
    if (actor.id === target.id) {
      throw new GameError("INVALID_TARGET", "不能与自己交换。");
    }
    if (actor.card.faceUp || target.card.faceUp) {
      throw new GameError("FACE_UP_FORBIDDEN", "任一方明牌时不能交换。");
    }

    const actorCard = { ...actor.card };
    actor.card = { ...target.card, version: target.card.version + 1 };
    target.card = { ...actorCard, version: actorCard.version + 1 };

    this.addLog(state, "swap", `${actor.name} 与 ${target.name} 交换了暗牌`, actor.id, target.id);
    this.finishActionAndAdvance(state);
    this.markUpdated(state);
    await this.persist(room);

    return {
      scopedState: buildPlayerScopedState(state, actor.id),
      publicState: buildPublicState(state),
    };
  }

  async handlePlayerSwapWithCenter(roomId: string, socketId: string): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const state = room.state;
    this.assertActionTurn(state, actorId, "swap_center");

    const actor = this.getPlayerOrThrow(state, actorId);
    if (actor.card.faceUp) {
      throw new GameError("FACE_UP_FORBIDDEN", "明牌状态不能与中间牌交换。");
    }
    if (!actor.alive) {
      throw new GameError("ACTOR_DEAD", "死亡玩家不能行动。");
    }

    const actorCard = { ...actor.card };
    actor.card = {
      role: state.centerCard.role,
      faceUp: false,
      version: state.centerCard.version + 1,
    };
    state.centerCard = {
      role: actorCard.role,
      faceUp: false,
      version: actorCard.version + 1,
    };

    this.addLog(state, "swap_center", `${actor.name} 与中间牌完成了交换`, actor.id);
    this.finishActionAndAdvance(state);
    this.markUpdated(state);
    await this.persist(room);

    return {
      scopedState: buildPlayerScopedState(state, actor.id),
      publicState: buildPublicState(state),
    };
  }

  async handlePlayerReveal(
    roomId: string,
    socketId: string,
    payload: {
      targetPlayerId?: string;
      followerIds?: string[];
      oraclePrediction?: WinFaction;
      inspectSubjects?: Array<
        | { subjectType: "player"; subjectId: string }
        | { subjectType: "center"; subjectId: "center" }
      >;
      triggerGlobalSwap?: boolean;
    },
  ): Promise<EngineMutationResult> {
    const room = await this.getRoomOrThrow(roomId);
    const actorId = this.resolvePlayerId(room, socketId);
    const state = room.state;
    this.assertActionTurn(state, actorId, "reveal");

    const actor = this.getPlayerOrThrow(state, actorId);
    if (actor.card.faceUp) {
      throw new GameError("ALREADY_REVEALED", "该身份牌已经公开。");
    }

    actor.card.faceUp = true;
    actor.card.version += 1;
    this.addLog(state, "reveal", `${actor.name} 公开了身份牌`, actor.id);

    let privateNotice: EngineMutationResult["privateNotice"];

    switch (actor.card.role) {
      case "sultan": {
        state.effects.sultanPlayerId = actor.id;
        state.effects.sultanCrownedRound = state.turn.round;
        this.addLog(state, "skill", `${actor.name} 完成加冕，成为明牌苏丹`, actor.id);

        if (payload.targetPlayerId) {
          const target = this.getPlayerOrThrow(state, payload.targetPlayerId);
          if (!target.card.faceUp) {
            throw new GameError("INVALID_EXECUTION_TARGET", "苏丹只能处决已公开的目标。");
          }
          if (effectiveFaction(target) !== "rebels") {
            throw new GameError("INVALID_EXECUTION_TARGET", "目标不是已公开的革命阵营角色。");
          }
          if (!target.alive) {
            throw new GameError("INVALID_EXECUTION_TARGET", "目标已经死亡。");
          }
          target.alive = false;
          target.card.faceUp = true;
          target.card.version += 1;
          this.addLog(state, "death", `${actor.name} 处决了 ${target.name}`, actor.id, target.id);
        }
        break;
      }
      case "assassin": {
        if (!payload.targetPlayerId) {
          throw new GameError("MISSING_TARGET", "刺客公开时必须指定刺杀目标。");
        }
        const target = this.getPlayerOrThrow(state, payload.targetPlayerId);
        if (!target.alive) {
          throw new GameError("INVALID_TARGET", "目标已经死亡。");
        }
        if (target.id === actor.id) {
          throw new GameError("INVALID_TARGET", "刺客不能把自己作为刺杀目标。");
        }

        const guardIds = this.findProtectingGuards(state, actor.id, target.id);
        if (guardIds.length > 0) {
          actor.alive = false;
          actor.card.faceUp = true;
          actor.card.version += 1;
          this.addLog(
            state,
            "death",
            `刺杀失败：${actor.name} 被守卫反制并死亡。`,
            actor.id,
          );
        } else {
          target.alive = false;
          target.card.faceUp = true;
          target.card.version += 1;
          this.addLog(state, "death", `${actor.name} 成功刺杀了 ${target.name}`, actor.id, target.id);
          if (target.card.role === "sultan") {
            state.effects.sultanKilledByAssassin = true;
          }
        }
        break;
      }
      case "guard": {
        if (!payload.targetPlayerId) {
          throw new GameError("MISSING_TARGET", "守卫公开时必须指定拘留目标。");
        }
        const target = this.getPlayerOrThrow(state, payload.targetPlayerId);
        if (!target.alive) {
          throw new GameError("INVALID_TARGET", "目标已经死亡。");
        }
        if (this.isGuardCharmed(state, actor.id)) {
          this.addLog(
            state,
            "skill",
            `${actor.name} 被肚皮舞娘魅惑，本回合无法拘留。`,
            actor.id,
          );
          break;
        }
        if (target.card.role === "sultan" || target.card.role === "guard") {
          this.addLog(
            state,
            "skill",
            `${actor.name} 试图拘留 ${target.name}，但目标免疫拘留。`,
            actor.id,
            target.id,
          );
          break;
        }
        target.skipActions += 1;
        this.addLog(state, "detain", `${actor.name} 拘留了 ${target.name}`, actor.id, target.id);
        break;
      }
      case "slave": {
        const followerIds = payload.followerIds ?? [];
        followerIds.forEach((id) => {
          const follower = this.getPlayerOrThrow(state, id);
          if (!follower.alive || follower.card.faceUp || follower.card.role !== "slave") {
            return;
          }
          if (!this.areAdjacent(state, actor.id, follower.id)) {
            return;
          }
          follower.card.faceUp = true;
          follower.card.version += 1;
          this.addLog(state, "skill", `${follower.name} 响应了奴隶起义`, follower.id);
        });
        this.addLog(state, "skill", `${actor.name} 发动了奴隶起义`, actor.id);
        break;
      }
      case "oracle": {
        if (!payload.oraclePrediction) {
          throw new GameError("MISSING_PREDICTION", "占卜师必须选择一个预言阵营。");
        }
        actor.oraclePrediction = payload.oraclePrediction;
        const subjects = payload.inspectSubjects ?? this.pickDefaultOracleSubjects(state, actor.id);
        if (subjects.length === 0) {
          throw new GameError("INVALID_ORACLE_TARGETS", "没有可占卜的目标。");
        }
        const cappedSubjects = subjects.slice(0, 3);
        const inspected = cappedSubjects.map((subject) => {
          if (subject.subjectType === "center") {
            actor.privateKnowledge.push({
              subjectType: "center",
              subjectId: "center",
              role: state.centerCard.role,
              observedVersion: state.centerCard.version,
              source: "oracle",
              turnSequence: state.turn.sequence,
            });
            return { ...subject, role: state.centerCard.role };
          }

          const target = this.getPlayerOrThrow(state, subject.subjectId);
          actor.privateKnowledge.push({
            subjectType: "player",
            subjectId: target.id,
            role: target.card.role,
            observedVersion: target.card.version,
            source: "oracle",
            turnSequence: state.turn.sequence,
          });
          return { subjectType: "player" as const, subjectId: target.id, role: target.card.role };
        });
        this.trimKnowledge(actor);

        privateNotice = {
          message: "占卜完成，私密结果已更新。",
          detail: {
            prediction: payload.oraclePrediction,
            inspected,
          },
        };
        this.addLog(
          state,
          "skill",
          `${actor.name} 完成了占卜并查看了三张牌。`,
          actor.id,
        );
        break;
      }
      case "belly_dancer": {
        this.addLog(state, "skill", `${actor.name} 公开为肚皮舞娘`, actor.id);
        if (payload.triggerGlobalSwap && state.settings.extensions.bellyDancerGlobalSwap) {
          this.performGlobalHiddenSwap(state);
          this.addLog(state, "skill", "肚皮舞娘触发了全场暗牌交换。", actor.id);
        }
        break;
      }
      default:
        break;
    }

    this.finishActionAndAdvance(state);
    this.markUpdated(state);
    await this.persist(room);

    return {
      scopedState: buildPlayerScopedState(state, actor.id),
      publicState: buildPublicState(state),
      privateNotice,
    };
  }

  private trimKnowledge(player: PlayerState): void {
    if (player.privateKnowledge.length <= 30) {
      return;
    }
    player.privateKnowledge = player.privateKnowledge.slice(-30);
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

  private currentPlayerId(state: GameState): string {
    return state.seatOrder[state.turn.currentSeatIndex];
  }

  private assertActionTurn(state: GameState, actorId: string, action: string): void {
    if (state.phase !== "in_game") {
      throw new GameError("GAME_NOT_RUNNING", "游戏尚未开始。");
    }
    if (state.winner) {
      throw new GameError("GAME_FINISHED", "本局已经结束。");
    }
    const currentId = this.currentPlayerId(state);
    if (currentId !== actorId) {
      throw new GameError("NOT_YOUR_TURN", `还没轮到你行动，当前应由 ${currentId} 行动。`);
    }
    const actor = this.getPlayerOrThrow(state, actorId);
    if (!actor.alive) {
      throw new GameError("ACTOR_DEAD", "死亡玩家不能行动。");
    }
    if (actor.skipActions > 0) {
      throw new GameError("PLAYER_DETAINED", "你已被拘留，暂时不能行动。");
    }
    if (!actor.connected) {
      throw new GameError("PLAYER_OFFLINE", "离线玩家不能行动。");
    }
    this.addLog(state, "system", `${actor.name} 执行了动作：${actionNameZh(action)}`, actor.id);
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

  private attachSocket(room: ActiveRoom, playerId: string, socketId: string): void {
    const prevSocket = room.socketByPlayerId.get(playerId);
    if (prevSocket) {
      room.playerBySocketId.delete(prevSocket);
      this.socketIndex.delete(prevSocket);
    }
    const existingBinding = this.socketIndex.get(socketId);
    if (existingBinding) {
      const previousRoom = this.rooms.get(existingBinding.roomId);
      if (previousRoom) {
        previousRoom.socketByPlayerId.delete(existingBinding.playerId);
        previousRoom.playerBySocketId.delete(socketId);
      }
    }
    room.socketByPlayerId.set(playerId, socketId);
    room.playerBySocketId.set(socketId, playerId);
    this.socketIndex.set(socketId, {
      roomId: room.state.roomId,
      playerId,
    });
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

  private advanceTurn(state: GameState): void {
    const prevIndex = state.turn.currentSeatIndex;
    const nextIndex = (prevIndex + 1) % state.seatOrder.length;
    state.turn.currentSeatIndex = nextIndex;
    state.turn.sequence += 1;
    if (nextIndex === 0) {
      state.turn.round += 1;
    }
  }

  private finishActionAndAdvance(state: GameState): void {
    if (state.phase !== "in_game") {
      return;
    }
    const immediate = this.checkWin(state);
    if (immediate) {
      this.applyWin(state, immediate.winnerFaction, immediate.reason);
      return;
    }

    this.advanceTurn(state);
    this.consumeSkippedTurns(state);

    const afterTurn = this.checkWin(state);
    if (afterTurn) {
      this.applyWin(state, afterTurn.winnerFaction, afterTurn.reason);
      return;
    }

    const current = state.players[this.currentPlayerId(state)];
    this.addLog(state, "turn", `第 ${state.turn.round} 轮，轮到 ${current.name} 行动。`);
  }

  private consumeSkippedTurns(state: GameState): void {
    for (let i = 0; i < state.seatOrder.length; i += 1) {
      const playerId = this.currentPlayerId(state);
      const player = state.players[playerId];
      if (!player.alive) {
        this.addLog(state, "turn", `${player.name} 已死亡，回合自动跳过。`, player.id);
        this.advanceTurn(state);
        continue;
      }
      if (player.skipActions > 0) {
        player.skipActions -= 1;
        this.addLog(state, "turn", `${player.name} 处于拘留状态，本回合被跳过。`, player.id);
        this.advanceTurn(state);
        continue;
      }
      return;
    }
  }

  private checkWin(state: GameState): { winnerFaction: WinFaction; reason: string } | null {
    if (state.effects.sultanKilledByAssassin) {
      return { winnerFaction: "rebels", reason: "刺客成功刺杀苏丹。" };
    }

    const slaveFlags = state.seatOrder.map((playerId) => {
      const player = state.players[playerId];
      return player.alive && player.card.faceUp && player.card.role === "slave";
    });
    if (countCircularMaxRun(slaveFlags) >= 3) {
      return { winnerFaction: "rebels", reason: "三张相邻且公开的奴隶触发起义成功。" };
    }

    if (state.effects.sultanPlayerId && state.effects.sultanCrownedRound !== undefined) {
      const sultan = state.players[state.effects.sultanPlayerId];
      if (
        sultan &&
        sultan.alive &&
        sultan.card.faceUp &&
        sultan.card.role === "sultan" &&
        state.turn.round > state.effects.sultanCrownedRound
      ) {
        return { winnerFaction: "loyalists", reason: "苏丹公开后成功存活整整一轮。" };
      }
    }

    return null;
  }

  private applyWin(state: GameState, faction: WinFaction, reason: string): void {
    const winners: string[] = [];
    state.seatOrder.forEach((playerId) => {
      const player = state.players[playerId];
      if (player.card.role === "oracle") {
        if (player.oraclePrediction && player.oraclePrediction === faction) {
          winners.push(player.id);
        }
        return;
      }
      const alignment = effectiveFaction(player);
      if (alignment === faction) {
        winners.push(player.id);
      }
    });

    state.winner = {
      winnerFaction: faction,
      winners,
      reason,
      endedAt: Date.now(),
    };
    state.phase = "finished";
    this.addLog(state, "win", `${factionNameZh(faction)}获胜：${reason}`);
  }

  private areAdjacent(state: GameState, leftId: string, rightId: string): boolean {
    const leftSeat = state.players[leftId]?.seatIndex;
    const rightSeat = state.players[rightId]?.seatIndex;
    if (leftSeat === undefined || rightSeat === undefined) {
      return false;
    }
    const [l, r] = circularAdjacentSeatIndices(leftSeat, state.seatOrder.length);
    return l === rightSeat || r === rightSeat;
  }

  private adjacentPlayers(state: GameState, playerId: string): string[] {
    const seatIndex = state.players[playerId]?.seatIndex;
    if (seatIndex === undefined) {
      return [];
    }
    const [left, right] = circularAdjacentSeatIndices(seatIndex, state.seatOrder.length);
    return [state.seatOrder[left], state.seatOrder[right]];
  }

  private isGuardCharmed(state: GameState, guardPlayerId: string): boolean {
    const adjacent = this.adjacentPlayers(state, guardPlayerId);
    return adjacent.some((id) => {
      const player = state.players[id];
      return player.alive && player.card.faceUp && player.card.role === "belly_dancer";
    });
  }

  private findProtectingGuards(state: GameState, assassinId: string, targetId: string): string[] {
    const aroundAssassin = this.adjacentPlayers(state, assassinId);
    const aroundTarget = this.adjacentPlayers(state, targetId);
    const candidates = new Set([...aroundAssassin, ...aroundTarget]);
    const guards: string[] = [];
    candidates.forEach((id) => {
      const player = state.players[id];
      if (!player || !player.alive) {
        return;
      }
      if (player.card.role !== "guard") {
        return;
      }
      if (this.isGuardCharmed(state, player.id)) {
        return;
      }
      guards.push(player.id);
    });
    return guards;
  }

  private pickDefaultOracleSubjects(
    state: GameState,
    oracleId: string,
  ): Array<{ subjectType: "player"; subjectId: string } | { subjectType: "center"; subjectId: "center" }> {
    const pool: Array<{ subjectType: "player"; subjectId: string } | { subjectType: "center"; subjectId: "center" }> =
      state.seatOrder
        .filter((id) => id !== oracleId)
        .map((id) => ({ subjectType: "player" as const, subjectId: id }));
    pool.push({ subjectType: "center", subjectId: "center" });
    return this.shuffle(pool).slice(0, 3);
  }

  private performGlobalHiddenSwap(state: GameState): void {
    const slots = state.seatOrder
      .map((playerId) => ({ playerId }))
      .filter(({ playerId }) => {
        const player = state.players[playerId];
        return player.alive && !player.card.faceUp;
      });
    const includeCenter = !state.centerCard.faceUp;
    if (includeCenter) {
      slots.push({ playerId: "__CENTER__" });
    }
    if (slots.length < 2) {
      return;
    }

    const pulled: Role[] = slots.map((slot) => {
      if (slot.playerId === "__CENTER__") {
        return state.centerCard.role;
      }
      return state.players[slot.playerId].card.role;
    });
    const shuffledRoles = this.shuffle(pulled);

    slots.forEach((slot, idx) => {
      if (slot.playerId === "__CENTER__") {
        state.centerCard.role = shuffledRoles[idx];
        state.centerCard.version += 1;
        return;
      }
      const player = state.players[slot.playerId];
      player.card.role = shuffledRoles[idx];
      player.card.version += 1;
    });
  }

  private shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}
