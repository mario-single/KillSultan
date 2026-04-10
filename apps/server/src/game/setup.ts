import {
  CardState,
  GameSettings,
  MAX_PLAYERS,
  MIN_PLAYERS,
  Role,
} from "@sultan/shared";

const BASE_SETTINGS: GameSettings = {
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  revealLogLimit: 100,
  extensions: {
    bellyDancerGlobalSwap: false,
  },
};

export function defaultSettings(): GameSettings {
  return structuredClone(BASE_SETTINGS);
}

export function buildDeck(playerCount: number): Role[] {
  const totalCards = playerCount + 1;
  const deck: Role[] = ["sultan", "assassin", "oracle", "belly_dancer"];

  if (deck.length < totalCards) {
    deck.push("guard");
  }
  if (deck.length < totalCards) {
    deck.push("slave");
  }

  // 剩余卡牌按守卫/奴隶交替填充，保证大局人数下仍有阵营对抗张力。
  let toggle: Role = "slave";
  while (deck.length < totalCards) {
    deck.push(toggle);
    toggle = toggle === "slave" ? "guard" : "slave";
  }

  return shuffle(deck);
}

export function createCard(role: Role, versionSeed = 1): CardState {
  return {
    role,
    faceUp: false,
    version: versionSeed,
  };
}

function shuffle<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
