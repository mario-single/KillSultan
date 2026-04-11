import { CardState, GameSettings, MAX_PLAYERS, MIN_PLAYERS, Role } from "@sultan/shared";

const BASE_SETTINGS: GameSettings = {
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  revealLogLimit: 100,
};

export function defaultSettings(): GameSettings {
  return structuredClone(BASE_SETTINGS);
}

export function buildDeck(playerCount: number): Role[] {
  const profile = deckProfileByPlayers(playerCount);
  const deck: Role[] = [];

  for (let i = 0; i < profile.sultan; i += 1) {
    deck.push("sultan");
  }
  for (let i = 0; i < profile.guard; i += 1) {
    deck.push("guard");
  }
  for (let i = 0; i < profile.assassin; i += 1) {
    deck.push("assassin");
  }
  for (let i = 0; i < profile.slave; i += 1) {
    deck.push("slave");
  }

  const neutralPool: Role[] = ["oracle", "belly_dancer", "slave_trader", "grand_official"];
  for (let i = 0; i < profile.neutral; i += 1) {
    deck.push(neutralPool[i % neutralPool.length]);
  }

  const expectedCards = playerCount + 1;
  if (deck.length !== expectedCards) {
    throw new Error(`invalid deck profile: expected ${expectedCards}, got ${deck.length}`);
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

function deckProfileByPlayers(playerCount: number): {
  sultan: number;
  guard: number;
  assassin: number;
  slave: number;
  neutral: number;
} {
  const map: Record<number, { sultan: number; guard: number; assassin: number; slave: number; neutral: number }> = {
    5: { sultan: 1, guard: 1, assassin: 1, slave: 3, neutral: 0 },
    6: { sultan: 1, guard: 1, assassin: 1, slave: 3, neutral: 1 },
    7: { sultan: 1, guard: 1, assassin: 1, slave: 3, neutral: 2 },
    8: { sultan: 1, guard: 2, assassin: 2, slave: 3, neutral: 1 },
    9: { sultan: 1, guard: 2, assassin: 2, slave: 3, neutral: 2 },
    10: { sultan: 1, guard: 2, assassin: 2, slave: 3, neutral: 3 },
    11: { sultan: 1, guard: 2, assassin: 2, slave: 4, neutral: 3 },
    12: { sultan: 1, guard: 3, assassin: 3, slave: 4, neutral: 2 },
    13: { sultan: 1, guard: 3, assassin: 3, slave: 4, neutral: 3 },
    14: { sultan: 1, guard: 3, assassin: 3, slave: 4, neutral: 4 },
    15: { sultan: 1, guard: 3, assassin: 3, slave: 5, neutral: 4 },
  };
  const found = map[playerCount];
  if (!found) {
    throw new Error(`unsupported playerCount: ${playerCount}`);
  }
  return found;
}
