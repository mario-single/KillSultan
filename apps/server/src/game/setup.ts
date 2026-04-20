import { CardState, GameSettings, MAX_PLAYERS, MIN_PLAYERS, Role } from "@sultan/shared";

const BASE_SETTINGS: GameSettings = {
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  revealLogLimit: 100,
};

export function defaultSettings(): GameSettings {
  return structuredClone(BASE_SETTINGS);
}

export function createCard(role: Role, versionSeed = 1): CardState {
  return {
    role,
    faceUp: false,
    version: versionSeed,
  };
}
