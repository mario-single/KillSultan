import { PlayerState, Role, WinFaction } from "./game-types.js";

export function roleBaseFaction(role: Role): WinFaction | "neutral" {
  switch (role) {
    case "sultan":
    case "guard":
      return "loyalists";
    case "assassin":
    case "slave":
      return "rebels";
    case "oracle":
    case "belly_dancer":
    case "slave_trader":
    case "grand_official":
      return "neutral";
    default:
      return "neutral";
  }
}

export function effectiveFaction(player: PlayerState): WinFaction | "neutral" {
  if (player.card.role === "belly_dancer") {
    return player.card.faceUp ? "rebels" : "loyalists";
  }
  return roleBaseFaction(player.card.role);
}

export function circularAdjacentSeatIndices(
  seatIndex: number,
  seatCount: number,
): [number, number] {
  const left = (seatIndex - 1 + seatCount) % seatCount;
  const right = (seatIndex + 1) % seatCount;
  return [left, right];
}

export function countCircularMaxRun(values: boolean[]): number {
  if (values.length === 0) {
    return 0;
  }
  if (values.every(Boolean)) {
    return values.length;
  }
  const doubled = [...values, ...values];
  let best = 0;
  let current = 0;
  for (let i = 0; i < doubled.length; i += 1) {
    if (doubled[i]) {
      current += 1;
      best = Math.max(best, Math.min(current, values.length));
    } else {
      current = 0;
    }
  }
  return best;
}
