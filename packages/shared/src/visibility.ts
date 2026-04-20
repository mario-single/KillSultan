import {
  GameState,
  PlayerScopedState,
  PrivateGameView,
  PublicGameView,
} from "./game-types.js";

export function buildPublicState(state: GameState): PublicGameView {
  return {
    roomId: state.roomId,
    phase: state.phase,
    hostPlayerId: state.hostPlayerId,
    settings: state.settings,
    players: state.seatOrder.map((playerId) => {
      const player = state.players[playerId];
      return {
        id: player.id,
        name: player.name,
        seatIndex: player.seatIndex,
        connected: player.connected,
        ready: player.ready,
        alive: player.alive,
        skipActions: player.skipActions,
        cardFaceUp: player.card.faceUp,
        revealedRole: player.card.faceUp ? player.card.role : undefined,
        finalRole: state.phase === "finished" ? player.card.role : undefined,
        publicPrediction:
          (player.card.faceUp || state.phase === "finished") && player.card.role === "oracle"
            ? player.oraclePrediction
            : undefined,
      };
    }),
    seatOrder: [...state.seatOrder],
    centerCardCount: 1,
    turn: { ...state.turn },
    currentPlayerId: state.seatOrder[state.turn.currentSeatIndex],
    turnDeadlineAt: state.effects.turnDeadlineAt,
    pendingAction: state.effects.pendingOraclePrediction
      ? {
          kind: "oracle_prediction",
          playerId: state.effects.pendingOraclePrediction.playerId,
        }
      : state.effects.pendingSlaveTrader
        ? {
            kind: "slave_trader_pick",
            playerId: state.effects.pendingSlaveTrader.playerId,
          }
      : state.effects.pendingSlaveUprising?.stage === "follow" && state.effects.pendingSlaveUprising.waitingPlayerIds.length > 0
        ? {
            kind: "slave_uprising_follow",
            initiatorPlayerId: state.effects.pendingSlaveUprising.initiatorPlayerId,
            sourcePlayerId: state.effects.pendingSlaveUprising.sourcePlayerId,
            responderPlayerIds: [...state.effects.pendingSlaveUprising.waitingPlayerIds],
            deadlineAt: state.effects.pendingSlaveUprising.deadlineAt,
          }
        : undefined,
    logs: state.logs.slice(-state.settings.revealLogLimit),
    winner: state.winner,
  };
}

function buildPrivateState(state: GameState, playerId: string): PrivateGameView {
  const player = state.players[playerId];
  const filteredKnowledge = player.privateKnowledge.filter((item) => {
    if (item.subjectType === "center") {
      return item.observedVersion === state.centerCard.version;
    }
    const target = state.players[item.subjectId];
    if (!target) {
      return false;
    }
    return item.observedVersion === target.card.version;
  });

  const centerKnown = filteredKnowledge.find(
    (item) => item.subjectType === "center" && item.subjectId === "center",
  );

  return {
    selfPlayerId: player.id,
    selfRole: state.phase === "lobby" ? undefined : player.card.role,
    selfCardFaceUp: player.card.faceUp,
    centerCardKnownRole: centerKnown?.role,
    privateKnowledge: filteredKnowledge,
    oraclePrediction: player.oraclePrediction,
  };
}

export function buildPlayerScopedState(
  state: GameState,
  playerId: string,
): PlayerScopedState {
  return {
    publicState: buildPublicState(state),
    privateState: buildPrivateState(state, playerId),
  };
}
