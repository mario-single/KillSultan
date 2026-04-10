export function buildPublicState(state) {
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
            };
        }),
        seatOrder: [...state.seatOrder],
        centerCardCount: 1,
        turn: { ...state.turn },
        currentPlayerId: state.seatOrder[state.turn.currentSeatIndex],
        logs: state.logs.slice(-state.settings.revealLogLimit),
        winner: state.winner,
    };
}
function buildPrivateState(state, playerId) {
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
    const centerKnown = filteredKnowledge.find((item) => item.subjectType === "center" && item.subjectId === "center");
    return {
        selfPlayerId: player.id,
        selfRole: player.card.role,
        selfCardFaceUp: player.card.faceUp,
        centerCardKnownRole: centerKnown?.role,
        privateKnowledge: filteredKnowledge,
        oraclePrediction: player.oraclePrediction,
    };
}
export function buildPlayerScopedState(state, playerId) {
    return {
        publicState: buildPublicState(state),
        privateState: buildPrivateState(state, playerId),
    };
}
