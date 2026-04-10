import { GameState } from "@sultan/shared";
import { Redis } from "ioredis";

import { StateStore } from "./state-store.js";

export class RedisStateStore implements StateStore {
  constructor(private readonly redis: Redis) {}

  private key(roomId: string): string {
    return `sultan:room:${roomId}`;
  }

  async save(state: GameState): Promise<void> {
    await this.redis.set(this.key(state.roomId), JSON.stringify(state));
  }

  async load(roomId: string): Promise<GameState | null> {
    const data = await this.redis.get(this.key(roomId));
    if (!data) {
      return null;
    }
    return JSON.parse(data) as GameState;
  }

  async delete(roomId: string): Promise<void> {
    await this.redis.del(this.key(roomId));
  }
}
