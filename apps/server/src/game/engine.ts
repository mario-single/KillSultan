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

    this.addLog(state, "system", `${playerName} created room ${roomId}`, playerId);

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
      throw new GameError("ROOM_ALREADY_STARTED", "Game already started; only reconnect is allowed.");
    }

    if (state.seatOrder.length >= state.settings.maxPlayers) {
      throw new GameError("ROOM_FULL", "Room is full.");
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
    this.addLog(state, "system", `${player.name} joined room`, playerId);
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
      throw new GameError("RESYNC_NOT_FOUND", "No matching player token in room.");
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
      this.addLog(room.state, "system", `${player.name} left the room`, playerId);

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
      this.addLog(room.state, "system", `${player.name} disconnected`, playerId);
    }

    this.markUpdated(room.state);
    await this.persist(room);
    return buildPublicState(room.state);
  }

  async setReady(roomId: string, socketId: string, ready: boolean): Promise<PublicGameView> {
    const room = await this.getRoomOrThrow(roomId);
    const playerId = this.resolvePlayerId(room, socketId);
    if (room.state.phase !== "lobby") {
      throw new GameError("GAME_ALREADY_STARTED", "Cannot set ready state after game starts.");
    }
    room.state.players[playerId].ready = ready;
    this.addLog(
      room.state,
      "system",
      `${room.state.players[playerId].name} is ${ready ? "ready" : "not ready"}`,
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
      throw new GameError("GAME_ALREADY_STARTED", "Game already started.");
    }
    if (state.hostPlayerId !== actorId) {
      throw new GameError("NOT_HOST", "Only host can start the game.");
    }
    if (state.seatOrder.length < MIN_PLAYERS || state.seatOrder.length > MAX_PLAYERS) {
      throw new GameError(
        "INVALID_PLAYER_COUNT",
        `Player count must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}.`,
      );
    }
    const unreadyPlayer = state.seatOrder.find((id) => !state.players[id].ready);
    if (unreadyPlayer) {
      throw new GameError("PLAYERS_NOT_READY", "All players must be ready before start.");
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
    this.addLog(state, "system", "Game started. Roles distributed.");
    this.addLog(
      state,
      "turn",
      `Round ${state.turn.round}, turn of ${state.players[this.currentPlayerId(state)].name}.`,
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
      this.addLog(room.state, "system", `${player.name} disconnected`, player.id);
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
      throw new GameError("ROOM_NOT_FOUND", "Room not found.");
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
      throw new GameError("TARGET_DEAD", "Cannot peek a dead player.");
    }
    if (actor.id === target.id) {
      throw new GameError("INVALID_TARGET", "Cannot peek yourself.");
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

    this.addLog(state, "peek", `${actor.name} peeked at ${target.name}`, actor.id, target.id);
    const privateNotice = {
      message: `Peek result: ${target.name} has role ${target.card.role}.`,
      detail: { targetPlayerId: target.id, role: target.card.role },
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
      throw new GameError("TARGET_DEAD", "Cannot swap with a dead player.");
    }
    if (actor.id === target.id) {
      throw new GameError("INVALID_TARGET", "Cannot swap with yourself.");
    }
    if (actor.card.faceUp || target.card.faceUp) {
      throw new GameError("FACE_UP_FORBIDDEN", "Cannot swap if either card is face-up.");
    }

    const actorCard = { ...actor.card };
    actor.card = { ...target.card, version: target.card.version + 1 };
    target.card = { ...actorCard, version: actorCard.version + 1 };

    this.addLog(state, "swap", `${actor.name} swapped with ${target.name}`, actor.id, target.id);
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
      throw new GameError("FACE_UP_FORBIDDEN", "Face-up cards cannot swap with center.");
    }
    if (!actor.alive) {
      throw new GameError("ACTOR_DEAD", "Dead players cannot act.");
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

    this.addLog(state, "swap_center", `${actor.name} swapped with center card`, actor.id);
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
      throw new GameError("ALREADY_REVEALED", "Card is already face-up.");
    }

    actor.card.faceUp = true;
    actor.card.version += 1;
    this.addLog(state, "reveal", `${actor.name} revealed their card`, actor.id);

    let privateNotice: EngineMutationResult["privateNotice"];

    switch (actor.card.role) {
      case "sultan": {
        state.effects.sultanPlayerId = actor.id;
        state.effects.sultanCrownedRound = state.turn.round;
        this.addLog(state, "skill", `${actor.name} crowned as Sultan`, actor.id);

        if (payload.targetPlayerId) {
          const target = this.getPlayerOrThrow(state, payload.targetPlayerId);
          if (!target.card.faceUp) {
            throw new GameError("INVALID_EXECUTION_TARGET", "Sultan can only execute a revealed target.");
          }
          if (effectiveFaction(target) !== "rebels") {
            throw new GameError("INVALID_EXECUTION_TARGET", "Target is not a revealed revolutionary.");
          }
          if (!target.alive) {
            throw new GameError("INVALID_EXECUTION_TARGET", "Target is already dead.");
          }
          target.alive = false;
          target.card.faceUp = true;
          target.card.version += 1;
          this.addLog(state, "death", `${actor.name} executed ${target.name}`, actor.id, target.id);
        }
        break;
      }
      case "assassin": {
        if (!payload.targetPlayerId) {
          throw new GameError("MISSING_TARGET", "Assassin reveal requires a target.");
        }
        const target = this.getPlayerOrThrow(state, payload.targetPlayerId);
        if (!target.alive) {
          throw new GameError("INVALID_TARGET", "Target is already dead.");
        }
        if (target.id === actor.id) {
          throw new GameError("INVALID_TARGET", "Assassin cannot target self.");
        }

        const guardIds = this.findProtectingGuards(state, actor.id, target.id);
        if (guardIds.length > 0) {
          actor.alive = false;
          actor.card.faceUp = true;
          actor.card.version += 1;
          this.addLog(
            state,
            "death",
            `Assassination failed. ${actor.name} was killed by guard protection.`,
            actor.id,
          );
        } else {
          target.alive = false;
          target.card.faceUp = true;
          target.card.version += 1;
          this.addLog(state, "death", `${actor.name} assassinated ${target.name}`, actor.id, target.id);
          if (target.card.role === "sultan") {
            state.effects.sultanKilledByAssassin = true;
          }
        }
        break;
      }
      case "guard": {
        if (!payload.targetPlayerId) {
          throw new GameError("MISSING_TARGET", "Guard reveal requires a detention target.");
        }
        const target = this.getPlayerOrThrow(state, payload.targetPlayerId);
        if (!target.alive) {
          throw new GameError("INVALID_TARGET", "Target is dead.");
        }
        if (this.isGuardCharmed(state, actor.id)) {
          this.addLog(
            state,
            "skill",
            `${actor.name} is charmed by Belly Dancer and cannot detain.`,
            actor.id,
          );
          break;
        }
        if (target.card.role === "sultan" || target.card.role === "guard") {
          this.addLog(
            state,
            "skill",
            `${actor.name} tried to detain ${target.name}, but target is immune.`,
            actor.id,
            target.id,
          );
          break;
        }
        target.skipActions += 1;
        this.addLog(state, "detain", `${actor.name} detained ${target.name}`, actor.id, target.id);
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
          this.addLog(state, "skill", `${follower.name} followed slave uprising`, follower.id);
        });
        this.addLog(state, "skill", `${actor.name} started a slave uprising`, actor.id);
        break;
      }
      case "oracle": {
        if (!payload.oraclePrediction) {
          throw new GameError("MISSING_PREDICTION", "Oracle must choose a prediction faction.");
        }
        actor.oraclePrediction = payload.oraclePrediction;
        const subjects = payload.inspectSubjects ?? this.pickDefaultOracleSubjects(state, actor.id);
        if (subjects.length === 0) {
          throw new GameError("INVALID_ORACLE_TARGETS", "No valid oracle subjects.");
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
          message: "Oracle insight ready.",
          detail: {
            prediction: payload.oraclePrediction,
            inspected,
          },
        };
        this.addLog(
          state,
          "skill",
          `${actor.name} made an oracle prediction and inspected three cards.`,
          actor.id,
        );
        break;
      }
      case "belly_dancer": {
        this.addLog(state, "skill", `${actor.name} revealed as Belly Dancer`, actor.id);
        if (payload.triggerGlobalSwap && state.settings.extensions.bellyDancerGlobalSwap) {
          this.performGlobalHiddenSwap(state);
          this.addLog(state, "skill", "Belly Dancer triggered global hidden-card swap.", actor.id);
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
      throw new GameError("ROOM_NOT_FOUND", "Room does not exist.");
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
      throw new GameError("NOT_IN_ROOM", "Socket is not bound to this room.");
    }
    return playerId;
  }

  private getPlayerOrThrow(state: GameState, playerId: string): PlayerState {
    const player = state.players[playerId];
    if (!player) {
      throw new GameError("PLAYER_NOT_FOUND", "Player not found.");
    }
    return player;
  }

  private currentPlayerId(state: GameState): string {
    return state.seatOrder[state.turn.currentSeatIndex];
  }

  private assertActionTurn(state: GameState, actorId: string, action: string): void {
    if (state.phase !== "in_game") {
      throw new GameError("GAME_NOT_RUNNING", "Game is not running.");
    }
    if (state.winner) {
      throw new GameError("GAME_FINISHED", "Game already finished.");
    }
    const currentId = this.currentPlayerId(state);
    if (currentId !== actorId) {
      throw new GameError("NOT_YOUR_TURN", `It's not your turn. Expected ${currentId}.`);
    }
    const actor = this.getPlayerOrThrow(state, actorId);
    if (!actor.alive) {
      throw new GameError("ACTOR_DEAD", "Dead players cannot act.");
    }
    if (actor.skipActions > 0) {
      throw new GameError("PLAYER_DETAINED", "You are detained and cannot act.");
    }
    if (!actor.connected) {
      throw new GameError("PLAYER_OFFLINE", "Disconnected players cannot act.");
    }
    this.addLog(state, "system", `${actor.name} performs action ${action}`, actor.id);
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
      throw new GameError("INVALID_NAME", "Player name is required.");
    }
    if (name.trim().length > 24) {
      throw new GameError("INVALID_NAME", "Player name is too long.");
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
    this.addLog(state, "turn", `Round ${state.turn.round}, turn of ${current.name}.`);
  }

  private consumeSkippedTurns(state: GameState): void {
    for (let i = 0; i < state.seatOrder.length; i += 1) {
      const playerId = this.currentPlayerId(state);
      const player = state.players[playerId];
      if (!player.alive) {
        this.addLog(state, "turn", `${player.name} is dead. Turn skipped.`, player.id);
        this.advanceTurn(state);
        continue;
      }
      if (player.skipActions > 0) {
        player.skipActions -= 1;
        this.addLog(state, "turn", `${player.name} is detained and skips this turn.`, player.id);
        this.advanceTurn(state);
        continue;
      }
      return;
    }
  }

  private checkWin(state: GameState): { winnerFaction: WinFaction; reason: string } | null {
    if (state.effects.sultanKilledByAssassin) {
      return { winnerFaction: "rebels", reason: "Assassin eliminated Sultan." };
    }

    const slaveFlags = state.seatOrder.map((playerId) => {
      const player = state.players[playerId];
      return player.alive && player.card.faceUp && player.card.role === "slave";
    });
    if (countCircularMaxRun(slaveFlags) >= 3) {
      return { winnerFaction: "rebels", reason: "Three adjacent face-up slaves triggered uprising." };
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
        return { winnerFaction: "loyalists", reason: "Crowned Sultan survived a full round." };
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
    this.addLog(state, "win", `${faction} win: ${reason}`);
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
