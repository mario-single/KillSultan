import cors from "cors";
import express from "express";
import http from "http";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import {
  AckResult,
  ClientToServerEvents,
  RoomCreatedData,
  RoomJoinedData,
  ServerToClientEvents,
} from "@sultan/shared";

import { env } from "./env.js";
import { GameEngine, GameError } from "./game/engine.js";
import { MemoryStateStore } from "./store/memory-store.js";
import { RedisStateStore } from "./store/redis-store.js";

const app = express();
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: env.corsOrigin },
});

const stateStore = env.redisUrl
  ? new RedisStateStore(new Redis(env.redisUrl))
  : new MemoryStateStore();
const engine = new GameEngine(stateStore);

const ok = <T>(data: T): AckResult<T> => ({ ok: true, data });
const fail = (code: string, message: string): AckResult<never> => ({
  ok: false,
  error: { code, message },
});

function mapError(err: unknown): { code: string; message: string } {
  if (err instanceof GameError) {
    return { code: err.code, message: err.message };
  }
  return {
    code: "INTERNAL_ERROR",
    message: err instanceof Error ? err.message : "Unknown error",
  };
}

async function syncRoom(roomId: string): Promise<void> {
  try {
    const publicState = await engine.getPublicState(roomId);
    io.to(roomId).emit("room:update", publicState);
    const targets = engine.getSocketTargets(roomId);
    targets.forEach((target) => {
      const scoped = engine.getScopedState(roomId, target.playerId);
      io.to(target.socketId).emit("game:state", scoped);
      if (publicState.phase === "finished") {
        io.to(target.socketId).emit("game:over", scoped);
      }
    });
  } catch {
    // Room may already be removed; no-op.
  }
}

io.on("connection", (socket) => {
  socket.on("room:create", async (payload, ack) => {
    try {
      const created: RoomCreatedData = await engine.createRoom(
        payload.playerName,
        socket.id,
        payload.token,
      );
      socket.join(created.roomId);
      ack(ok(created));
      await syncRoom(created.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("room:join", async (payload, ack) => {
    try {
      const joined: RoomJoinedData = await engine.joinRoom(
        payload.roomId,
        payload.playerName,
        socket.id,
        payload.token,
      );
      socket.join(payload.roomId);
      ack(ok(joined));
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("state:resync", async (payload, ack) => {
    try {
      const scoped = await engine.resyncByToken(payload.roomId, payload.token, socket.id);
      socket.join(payload.roomId);
      ack(ok(scoped));
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("room:leave", async (payload, ack) => {
    try {
      const updated = await engine.leaveRoom(payload.roomId, socket.id);
      socket.leave(payload.roomId);
      ack(ok(updated));
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("room:ready", async (payload, ack) => {
    try {
      const updated = await engine.setReady(payload.roomId, socket.id, payload.ready);
      ack(ok(updated));
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("game:start", async (payload, ack) => {
    try {
      const updated = await engine.startGame(payload.roomId, socket.id);
      ack(ok(updated));
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("action:peek", async (payload, ack) => {
    try {
      const result = await engine.handlePlayerPeek(payload.roomId, socket.id, payload.targetPlayerId);
      ack(ok(result.scopedState));
      if (result.privateNotice) {
        socket.emit("game:private", result.privateNotice);
      }
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("action:swap", async (payload, ack) => {
    try {
      const result = await engine.handlePlayerSwap(payload.roomId, socket.id, payload.targetPlayerId);
      ack(ok(result.scopedState));
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("action:swapCenter", async (payload, ack) => {
    try {
      const result = await engine.handlePlayerSwapWithCenter(payload.roomId, socket.id);
      ack(ok(result.scopedState));
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("action:reveal", async (payload, ack) => {
    try {
      const result = await engine.handlePlayerReveal(payload.roomId, socket.id, payload);
      ack(ok(result.scopedState));
      if (result.privateNotice) {
        socket.emit("game:private", result.privateNotice);
      }
      await syncRoom(payload.roomId);
    } catch (err) {
      const mapped = mapError(err);
      ack(fail(mapped.code, mapped.message));
      socket.emit("game:error", mapped);
    }
  });

  socket.on("disconnect", async () => {
    const out = await engine.disconnectSocket(socket.id);
    if (out.roomId) {
      await syncRoom(out.roomId);
    }
  });
});

server.listen(env.port, () => {
  console.log(`server listening on http://localhost:${env.port}`);
});
