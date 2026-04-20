import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { ActionRevealPayload, GameState } from "@sultan/shared";

import { GameError } from "./game-error.js";

export interface CoreRulesMutationResult {
  state: GameState;
  privateNotice?: {
    message: string;
    detail?: unknown;
  };
}

type CoreRulesCommand =
  | "start_game"
  | "action_peek"
  | "action_swap"
  | "action_swap_center"
  | "action_reveal"
  | "action_decline_follow"
  | "action_oracle_prediction"
  | "action_end_turn"
  | "action_slave_trader_pick"
  | "disconnect";

interface CoreRulesSuccess {
  ok: true;
  data: CoreRulesMutationResult;
}

interface CoreRulesFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

type CoreRulesResponse = CoreRulesSuccess | CoreRulesFailure;

const pythonBin = process.env.CORE_RULES_PYTHON_BIN ?? "python";
const cliPath = fileURLToPath(new URL("../../../core_rules/cli.py", import.meta.url));

export class CoreRulesBridge {
  async startGame(state: GameState, actorId: string): Promise<CoreRulesMutationResult> {
    return this.execute("start_game", { state, actorId });
  }

  async actionPeek(state: GameState, actorId: string, targetPlayerId: string): Promise<CoreRulesMutationResult> {
    return this.execute("action_peek", { state, actorId, targetPlayerId });
  }

  async actionSwap(state: GameState, actorId: string, targetPlayerId: string): Promise<CoreRulesMutationResult> {
    return this.execute("action_swap", { state, actorId, targetPlayerId });
  }

  async actionSwapCenter(state: GameState, actorId: string): Promise<CoreRulesMutationResult> {
    return this.execute("action_swap_center", { state, actorId });
  }

  async actionReveal(
    state: GameState,
    actorId: string,
    payload: ActionRevealPayload,
  ): Promise<CoreRulesMutationResult> {
    return this.execute("action_reveal", { state, actorId, payload });
  }

  async actionDeclineFollow(state: GameState, actorId: string): Promise<CoreRulesMutationResult> {
    return this.execute("action_decline_follow", { state, actorId });
  }

  async actionOraclePrediction(
    state: GameState,
    actorId: string,
    prediction: "rebels" | "loyalists",
  ): Promise<CoreRulesMutationResult> {
    return this.execute("action_oracle_prediction", { state, actorId, prediction });
  }

  async actionEndTurn(state: GameState, actorId: string): Promise<CoreRulesMutationResult> {
    return this.execute("action_end_turn", { state, actorId });
  }

  async actionSlaveTraderPick(
    state: GameState,
    actorId: string,
    targetPlayerId: string,
  ): Promise<CoreRulesMutationResult> {
    return this.execute("action_slave_trader_pick", { state, actorId, targetPlayerId });
  }

  async disconnect(state: GameState, playerId: string): Promise<CoreRulesMutationResult> {
    return this.execute("disconnect", { state, playerId });
  }

  private async execute(
    command: CoreRulesCommand,
    payload: Record<string, unknown>,
  ): Promise<CoreRulesMutationResult> {
    const requestJson = JSON.stringify({ command, ...payload });
    const responseJson = await this.runPython(requestJson);

    let response: CoreRulesResponse;
    try {
      response = JSON.parse(responseJson) as CoreRulesResponse;
    } catch (error) {
      throw new GameError(
        "CORE_RULES_PROTOCOL_ERROR",
        `Python core_rules returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new GameError(response.error.code, response.error.message);
    }

    return response.data;
  }

  private runPython(stdin: string): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(pythonBin, ["-X", "utf8", cliPath], {
        cwd: resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
        },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        rejectPromise(
          new GameError("CORE_RULES_PROCESS_ERROR", `Failed to launch Python core_rules: ${error.message}`),
        );
      });
      child.on("close", (code) => {
        if (code !== 0 && stdout.trim().length === 0) {
          rejectPromise(
            new GameError(
              "CORE_RULES_PROCESS_ERROR",
              stderr.trim() || `Python core_rules exited with code ${code ?? "unknown"}.`,
            ),
          );
          return;
        }
        resolvePromise(stdout);
      });

      child.stdin.end(stdin);
    });
  }
}
