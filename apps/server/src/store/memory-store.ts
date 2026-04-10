import { GameState } from "@sultan/shared";

import { StateStore } from "./state-store.js";

export class MemoryStateStore implements StateStore {
  private readonly snapshots = new Map<string, GameState>();

  async save(state: GameState): Promise<void> {
    this.snapshots.set(state.roomId, structuredClone(state));
  }

  async load(roomId: string): Promise<GameState | null> {
    const found = this.snapshots.get(roomId);
    return found ? structuredClone(found) : null;
  }

  async delete(roomId: string): Promise<void> {
    this.snapshots.delete(roomId);
  }
}
