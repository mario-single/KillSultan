import { GameState } from "@sultan/shared";

export interface StateStore {
  save(state: GameState): Promise<void>;
  load(roomId: string): Promise<GameState | null>;
  delete(roomId: string): Promise<void>;
}
