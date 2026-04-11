import {
  ActionRevealPayload,
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

import { buildDeck, createCard, defaultSettings } from "./setup.js";
import { StateStore } from "../store/state-store.js";

interface ActiveRoom {
  state: GameState;
  socketByPlayerId: Map<string, string>;
  playerBySocketId: Map<string, string>;
}

interface WinCheck {
  winnerFaction: WinFaction;
  reason: string;
  reasonCode: "ASSASSIN_KILL" | "SLAVE_UPRISING" | "SULTAN_SURVIVE";
}

type ForceSkillPayload = NonNullable<ActionRevealPayload["forceSkill"]>;

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
  slave_trader: "奴隶贩子",
  grand_official: "大官",
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
    this.addLog(room.state, "system", `${room.state.players[playerId].name} ${ready ? "已准备" : "取消准备"}`);
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
    const unready = state.seatOrder.find((id) => !state.players[id].ready);
    if (unready) {
      throw new GameError("PLAYERS_NOT_READY", "开始前需要所有玩家都准备。");
    }

    const deck = buildDeck(state.seatOrder.length);
    state.seatOrder.forEach((playerId, index) => {
      const player = state.players[playerId];
      player.card = createCard(deck[index], 1);
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
    this.addLog(state, "turn", `第 ${state.turn.round} 轮，轮到 ${state.players[this.currentPlayerId(state)].name} 行动。`);
    this.markUpdated(state);
    await this.persist(room);
    return buildPublicState(state);
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
      detail: {
        targetPlayerId: target.id,
        role: target.card.role,
        roleNameZh: roleNameZh(target.card.role),
      },
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
    if (target.id === actor.id) {
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
    payload: ActionRevealPayload,
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

    const privateNotice = this.executeRoleSkill(state, actor.id, payload, false, 0);

    this.finishActionAndAdvance(state);
    this.markUpdated(state);
    await this.persist(room);
    return {
      scopedState: buildPlayerScopedState(state, actor.id),
      publicState: buildPublicState(state),
      privateNotice,
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

  private executeRoleSkill(
    state: GameState,
    actorId: string,
    payload: ActionRevealPayload,
    forced: boolean,
    depth: number,
  ): EngineMutationResult["privateNotice"] {
    const actor = this.getPlayerOrThrow(state, actorId);
    const fail = (code: string, message: string): boolean => {
      if (!forced) {
        throw new GameError(code, message);
      }
      this.addLog(state, "skill", `${actor.name} 的被强制技能未生效：${message}`, actor.id);
      return true;
    };

    switch (actor.card.role) {
      case "sultan": {
        state.effects.sultanPlayerId = actor.id;
        state.effects.sultanCrownedRound = state.turn.round;
        this.addLog(state, "skill", `${actor.name} 完成加冕，成为明牌苏丹`, actor.id);
        if (payload.targetPlayerId) {
          const target = this.getPlayerOrThrow(state, payload.targetPlayerId);
          if (!target.card.faceUp && fail("INVALID_EXECUTION_TARGET", "苏丹只能处决已公开目标。")) {
            break;
          }
          if (effectiveFaction(target) !== "rebels" && fail("INVALID_EXECUTION_TARGET", "目标不是公开的革命阵营角色。")) {
            break;
          }
          if (!target.alive && fail("INVALID_EXECUTION_TARGET", "目标已经死亡。")) {
            break;
          }
          target.alive = false;
          target.card.faceUp = true;
          target.card.version += 1;
          this.addLog(state, "death", `${actor.name} 处决了 ${target.name}`, actor.id, target.id);
        }
        break;
      }
      case "assassin": {
        if (!payload.targetPlayerId && fail("MISSING_TARGET", "刺客公开时必须指定刺杀目标。")) {
          break;
        }
        const target = this.getPlayerOrThrow(state, payload.targetPlayerId!);
        if (!target.alive && fail("INVALID_TARGET", "目标已经死亡。")) {
          break;
        }
        if (target.id === actor.id && fail("INVALID_TARGET", "刺客不能刺杀自己。")) {
          break;
        }
        const guards = this.findProtectingGuards(state, actor.id, target.id);
        if (guards.length > 0) {
          actor.alive = false;
          actor.card.faceUp = true;
          actor.card.version += 1;
          this.addLog(state, "death", `刺杀失败：${actor.name} 被守卫反制并死亡。`, actor.id);
        } else {
          target.alive = false;
          target.card.faceUp = true;
          target.card.version += 1;
          this.addLog(state, "death", `${actor.name} 成功刺杀了 ${target.name}`, actor.id, target.id);
          if (target.card.role === "sultan") {
            state.effects.sultanKilledByAssassin = true;
            state.effects.assassinKillerPlayerId = actor.id;
          }
        }
        break;
      }
      case "guard": {
        if (!payload.targetPlayerId && fail("MISSING_TARGET", "守卫公开时必须指定拘留目标。")) {
          break;
        }
        const target = this.getPlayerOrThrow(state, payload.targetPlayerId!);
        if (!target.alive && fail("INVALID_TARGET", "目标已经死亡。")) {
          break;
        }
        if (this.isGuardCharmed(state, actor.id)) {
          this.addLog(state, "skill", `${actor.name} 被肚皮舞娘魅惑，本回合不能拘留。`, actor.id);
          break;
        }
        if (target.card.role === "sultan" || target.card.role === "guard") {
          this.addLog(state, "skill", `${actor.name} 试图拘留 ${target.name}，但目标免疫。`, actor.id, target.id);
          break;
        }
        target.skipActions += 1;
        this.addLog(state, "detain", `${actor.name} 拘留了 ${target.name}`, actor.id, target.id);
        break;
      }
      case "slave": {
        const followerIds = payload.followerIds ?? [];
        followerIds.forEach((id) => {
          const follower = state.players[id];
          if (!follower || !follower.alive || follower.card.faceUp || follower.card.role !== "slave") {
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
        if (!payload.oraclePrediction && fail("MISSING_PREDICTION", "占卜师必须选择预言阵营。")) {
          break;
        }
        actor.oraclePrediction = payload.oraclePrediction!;
        const subjects = payload.inspectSubjects ?? this.pickDefaultOracleSubjects(state, actor.id);
        const selected = subjects.slice(0, 3);
        const inspected = selected.map((subject) => {
          if (subject.subjectType === "center") {
            actor.privateKnowledge.push({
              subjectType: "center",
              subjectId: "center",
              role: state.centerCard.role,
              observedVersion: state.centerCard.version,
              source: "oracle",
              turnSequence: state.turn.sequence,
            });
            return { subjectType: "center" as const, subjectId: "center", role: state.centerCard.role };
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
        this.addLog(state, "skill", `${actor.name} 完成了占卜并查看三张牌`, actor.id);
        if (!forced) {
          return {
            message: "占卜完成，私密结果已更新。",
            detail: {
              prediction: actor.oraclePrediction,
              predictionNameZh: factionNameZh(actor.oraclePrediction),
              inspected: inspected.map((item) => ({ ...item, roleNameZh: roleNameZh(item.role) })),
            },
          };
        }
        break;
      }
      case "belly_dancer": {
        this.addLog(state, "skill", `${actor.name} 公开为肚皮舞娘，相邻守卫会失效。`, actor.id);
        break;
      }
      case "slave_trader": {
        const targets = payload.slaveTraderTargets ?? [];
        if (targets.length === 0 && fail("MISSING_TARGET", "奴隶贩子需要至少一个目标。")) {
          break;
        }
        let repeated = 0;
        for (const targetId of targets) {
          const target = state.players[targetId];
          if (!target || !target.alive) {
            this.addLog(state, "skill", `${actor.name} 选择了无效目标，技能终止。`, actor.id);
            break;
          }
          if (target.card.role === "slave") {
            target.skipActions += 1;
            repeated += 1;
            this.addLog(state, "detain", `${actor.name} 识别奴隶并拘留了 ${target.name}`, actor.id, target.id);
            continue;
          }
          this.addLog(state, "skill", `${actor.name} 选择了 ${target.name}，其并非奴隶，技能无事发生。`, actor.id, target.id);
          break;
        }
        if (repeated > 0) {
          this.addLog(state, "skill", `${actor.name} 的奴隶贩子技能连续触发了 ${repeated} 次。`, actor.id);
        }
        break;
      }
      case "grand_official": {
        if (!payload.targetPlayerId && fail("MISSING_TARGET", "大官必须指定被强制执行技能的玩家。")) {
          break;
        }
        if (depth >= 2) {
          this.addLog(state, "skill", `${actor.name} 的强制技能层级过深，已终止。`, actor.id);
          break;
        }
        const target = this.getPlayerOrThrow(state, payload.targetPlayerId!);
        if (!target.alive && fail("INVALID_TARGET", "被强制执行技能的目标已死亡。")) {
          break;
        }
        this.addLog(state, "skill", `${actor.name} 强制 ${target.name} 执行技能`, actor.id, target.id);
        this.forceRevealAndExecuteSkill(state, actor.id, target.id, payload.forceSkill ?? {}, depth + 1);
        break;
      }
      default:
        break;
    }
    return undefined;
  }

  private forceRevealAndExecuteSkill(
    state: GameState,
    byPlayerId: string,
    targetPlayerId: string,
    forcePayload: ForceSkillPayload,
    depth: number,
  ): void {
    const byPlayer = this.getPlayerOrThrow(state, byPlayerId);
    const target = this.getPlayerOrThrow(state, targetPlayerId);
    if (!target.alive) {
      this.addLog(state, "skill", `${byPlayer.name} 的强制技能失败：目标已死亡。`, byPlayer.id, target.id);
      return;
    }

    if (!target.card.faceUp) {
      target.card.faceUp = true;
      target.card.version += 1;
      this.addLog(state, "reveal", `${target.name} 被强制公开身份牌`, byPlayer.id, target.id);
    }

    const converted: ActionRevealPayload = {
      targetPlayerId: forcePayload.targetPlayerId,
      followerIds: forcePayload.followerIds,
      slaveTraderTargets: forcePayload.slaveTraderTargets,
      oraclePrediction: forcePayload.oraclePrediction,
      inspectSubjects: forcePayload.inspectSubjects,
      forceSkill: forcePayload,
    };
    this.executeRoleSkill(state, target.id, converted, true, depth);
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

  private advanceTurn(state: GameState): void {
    const prev = state.turn.currentSeatIndex;
    const next = (prev + 1) % state.seatOrder.length;
    state.turn.currentSeatIndex = next;
    state.turn.sequence += 1;
    if (next === 0) {
      state.turn.round += 1;
    }
  }

  private finishActionAndAdvance(state: GameState): void {
    if (state.phase !== "in_game") {
      return;
    }
    const immediate = this.checkWin(state);
    if (immediate) {
      this.applyWin(state, immediate);
      return;
    }

    this.advanceTurn(state);
    this.consumeSkippedTurns(state);

    const afterTurn = this.checkWin(state);
    if (afterTurn) {
      this.applyWin(state, afterTurn);
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

  private checkWin(state: GameState): WinCheck | null {
    if (state.effects.sultanKilledByAssassin) {
      return {
        winnerFaction: "rebels",
        reason: "刺客成功刺杀苏丹。",
        reasonCode: "ASSASSIN_KILL",
      };
    }

    const slaveFlags = state.seatOrder.map((id) => {
      const player = state.players[id];
      return player.alive && player.card.faceUp && player.card.role === "slave";
    });
    if (countCircularMaxRun(slaveFlags) >= 3) {
      return {
        winnerFaction: "rebels",
        reason: "三张相邻且公开的奴隶触发起义成功。",
        reasonCode: "SLAVE_UPRISING",
      };
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
        return {
          winnerFaction: "loyalists",
          reason: "苏丹公开后成功存活整整一轮。",
          reasonCode: "SULTAN_SURVIVE",
        };
      }
    }

    return null;
  }

  private applyWin(state: GameState, win: WinCheck): void {
    const winners = new Set<string>();
    const scoreByPlayerId: Record<string, number> = {};
    state.seatOrder.forEach((id) => {
      scoreByPlayerId[id] = 0;
    });

    state.seatOrder.forEach((playerId) => {
      const player = state.players[playerId];
      if (player.card.role === "oracle") {
        if (player.oraclePrediction === win.winnerFaction) {
          winners.add(player.id);
          scoreByPlayerId[player.id] = 1;
        }
        return;
      }
      const alignment = effectiveFaction(player);
      if (alignment === win.winnerFaction) {
        winners.add(player.id);
        scoreByPlayerId[player.id] = 1;
      }
    });

    if (win.reasonCode === "SULTAN_SURVIVE" && state.effects.sultanPlayerId) {
      scoreByPlayerId[state.effects.sultanPlayerId] = 2;
      winners.add(state.effects.sultanPlayerId);
    }
    if (win.reasonCode === "ASSASSIN_KILL" && state.effects.assassinKillerPlayerId) {
      scoreByPlayerId[state.effects.assassinKillerPlayerId] = 2;
      winners.add(state.effects.assassinKillerPlayerId);
    }

    state.seatOrder.forEach((playerId) => {
      const player = state.players[playerId];
      if (player.card.role !== "grand_official") {
        return;
      }
      const adjacent = this.adjacentPlayers(state, player.id);
      const sum = adjacent.reduce((acc, id) => acc + (scoreByPlayerId[id] ?? 0), 0);
      if (sum >= 2) {
        winners.add(player.id);
        if (scoreByPlayerId[player.id] < 1) {
          scoreByPlayerId[player.id] = 1;
        }
        this.addLog(state, "skill", `${player.name} 的大官附加胜利条件达成（相邻得分 ${sum}）。`, player.id);
      }
    });

    state.winner = {
      winnerFaction: win.winnerFaction,
      winners: Array.from(winners),
      reason: win.reason,
      scoreByPlayerId,
      endedAt: Date.now(),
    };
    state.phase = "finished";
    this.addLog(state, "win", `${factionNameZh(win.winnerFaction)}获胜：${win.reason}`);
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
    const seat = state.players[playerId]?.seatIndex;
    if (seat === undefined) {
      return [];
    }
    const [left, right] = circularAdjacentSeatIndices(seat, state.seatOrder.length);
    return [state.seatOrder[left], state.seatOrder[right]];
  }

  private isGuardCharmed(state: GameState, guardPlayerId: string): boolean {
    const adjacent = this.adjacentPlayers(state, guardPlayerId);
    return adjacent.some((id) => {
      const player = state.players[id];
      return player && player.alive && player.card.faceUp && player.card.role === "belly_dancer";
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

  private shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}
