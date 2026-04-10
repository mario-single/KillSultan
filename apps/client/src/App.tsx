import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  AckResult,
  ClientToServerEvents,
  PlayerScopedState,
  ServerToClientEvents,
  WinFaction,
} from "@sultan/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000";

const TOKEN_KEY = "sultan_token";
const ROOM_KEY = "sultan_room_id";
const NAME_KEY = "sultan_name";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function unwrapAck<T>(result: AckResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

export function App() {
  const socketRef = useRef<ClientSocket | null>(null);

  const [playerName, setPlayerName] = useState(localStorage.getItem(NAME_KEY) ?? "");
  const [roomIdInput, setRoomIdInput] = useState(localStorage.getItem(ROOM_KEY) ?? "");
  const [token, setToken] = useState(localStorage.getItem(TOKEN_KEY) ?? "");
  const [myPlayerId, setMyPlayerId] = useState<string>("");
  const [scopedState, setScopedState] = useState<PlayerScopedState | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [privateFeed, setPrivateFeed] = useState<string[]>([]);

  const [selectedTarget, setSelectedTarget] = useState("");
  const [oraclePrediction, setOraclePrediction] = useState<WinFaction>("rebels");
  const [followerInput, setFollowerInput] = useState("");
  const [triggerGlobalSwap, setTriggerGlobalSwap] = useState(false);

  useEffect(() => {
    const socket: ClientSocket = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("game:state", (nextState) => {
      setScopedState(nextState);
    });

    socket.on("room:update", (publicState) => {
      setScopedState((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          publicState,
          privateState: prev.privateState,
        };
      });
    });

    socket.on("game:private", (payload) => {
      setPrivateFeed((prev) => [payload.message, ...prev].slice(0, 40));
    });

    socket.on("game:error", (payload) => {
      setErrors((prev) => [`${payload.code}: ${payload.message}`, ...prev].slice(0, 20));
    });

    socket.on("game:over", (nextState) => {
      setScopedState(nextState);
      setPrivateFeed((prev) => ["Game ended.", ...prev].slice(0, 40));
    });

    socket.on("connect", () => {
      const savedToken = localStorage.getItem(TOKEN_KEY);
      const savedRoom = localStorage.getItem(ROOM_KEY);
      if (!savedToken || !savedRoom) {
        return;
      }
      socket.emit("state:resync", { roomId: savedRoom, token: savedToken }, (result) => {
        try {
          const data = unwrapAck(result);
          setScopedState(data);
          setMyPlayerId(data.privateState.selfPlayerId);
        } catch (err) {
          setErrors((prev) => [`Resync failed: ${String(err)}`, ...prev].slice(0, 20));
        }
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const publicState = scopedState?.publicState;
  const privateState = scopedState?.privateState;
  const currentPlayerId = publicState?.currentPlayerId;
  const isMyTurn = currentPlayerId === myPlayerId;

  const me = publicState?.players.find((player) => player.id === myPlayerId);

  function addError(message: string): void {
    setErrors((prev) => [message, ...prev].slice(0, 20));
  }

  function createRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (!playerName.trim()) {
      addError("Player name is required.");
      return;
    }

    socket.emit("room:create", { playerName: playerName.trim(), token: token || undefined }, (result) => {
      try {
        const data = unwrapAck(result);
        setToken(data.token);
        setMyPlayerId(data.playerId);
        setRoomIdInput(data.roomId);
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(ROOM_KEY, data.roomId);
        localStorage.setItem(NAME_KEY, playerName.trim());
      } catch (err) {
        addError(String(err));
      }
    });
  }

  function joinRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (!playerName.trim()) {
      addError("Player name is required.");
      return;
    }
    if (!roomIdInput.trim()) {
      addError("Room ID is required.");
      return;
    }

    socket.emit(
      "room:join",
      {
        roomId: roomIdInput.trim().toUpperCase(),
        playerName: playerName.trim(),
        token: token || undefined,
      },
      (result) => {
        try {
          const data = unwrapAck(result);
          setToken(data.token);
          setMyPlayerId(data.playerId);
          localStorage.setItem(TOKEN_KEY, data.token);
          localStorage.setItem(ROOM_KEY, data.roomId);
          localStorage.setItem(NAME_KEY, playerName.trim());
        } catch (err) {
          addError(String(err));
        }
      },
    );
  }

  function toggleReady(): void {
    const socket = socketRef.current;
    if (!socket || !publicState || !me) {
      return;
    }
    socket.emit("room:ready", { roomId: publicState.roomId, ready: !me.ready }, (result) => {
      if (!result.ok) {
        addError(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function startGame(): void {
    const socket = socketRef.current;
    if (!socket || !publicState) {
      return;
    }
    socket.emit("game:start", { roomId: publicState.roomId }, (result) => {
      if (!result.ok) {
        addError(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function doPeek(): void {
    const socket = socketRef.current;
    if (!socket || !publicState || !selectedTarget) {
      return;
    }
    socket.emit("action:peek", { roomId: publicState.roomId, targetPlayerId: selectedTarget }, (result) => {
      if (!result.ok) {
        addError(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function doSwap(): void {
    const socket = socketRef.current;
    if (!socket || !publicState || !selectedTarget) {
      return;
    }
    socket.emit("action:swap", { roomId: publicState.roomId, targetPlayerId: selectedTarget }, (result) => {
      if (!result.ok) {
        addError(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function doSwapCenter(): void {
    const socket = socketRef.current;
    if (!socket || !publicState) {
      return;
    }
    socket.emit("action:swapCenter", { roomId: publicState.roomId }, (result) => {
      if (!result.ok) {
        addError(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function doReveal(): void {
    const socket = socketRef.current;
    if (!socket || !publicState) {
      return;
    }
    const followerIds = followerInput
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    socket.emit(
      "action:reveal",
      {
        roomId: publicState.roomId,
        targetPlayerId: selectedTarget || undefined,
        oraclePrediction,
        followerIds: followerIds.length > 0 ? followerIds : undefined,
        triggerGlobalSwap,
      },
      (result) => {
        if (!result.ok) {
          addError(`${result.error.code}: ${result.error.message}`);
        }
      },
    );
  }

  function leaveRoom(): void {
    const socket = socketRef.current;
    if (!socket || !publicState) {
      return;
    }
    socket.emit("room:leave", { roomId: publicState.roomId }, (_result) => {
      setScopedState(null);
      setMyPlayerId("");
      setSelectedTarget("");
      setFollowerInput("");
      localStorage.removeItem(ROOM_KEY);
    });
  }

  if (!publicState) {
    return (
      <div className="shell">
        <div className="hero">
          <h1>Sultan Online</h1>
          <p>Realtime hidden-identity game prototype</p>
        </div>
        <div className="card">
          <label>Player Name</label>
          <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
          <label>Room ID (for join)</label>
          <input value={roomIdInput} onChange={(e) => setRoomIdInput(e.target.value.toUpperCase())} />
          <div className="row">
            <button onClick={createRoom}>Create Room</button>
            <button onClick={joinRoom}>Join Room</button>
          </div>
        </div>
        <ErrorFeed errors={errors} />
      </div>
    );
  }

  const actionDisabled = publicState.phase !== "in_game" || !isMyTurn;

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Room {publicState.roomId}</h1>
        <div className="topbar-meta">
          <span>You: {me?.name}</span>
          <span>Role: {privateState?.selfRole}</span>
          <button onClick={leaveRoom}>Leave</button>
        </div>
      </header>

      <section className="grid">
        <article className="panel">
          <h2>Players</h2>
          <ul>
            {publicState.players.map((player) => (
              <li key={player.id} className={player.id === currentPlayerId ? "active" : ""}>
                <button onClick={() => setSelectedTarget(player.id)}>{player.name}</button>
                <span>{player.alive ? "alive" : "dead"}</span>
                <span>{player.cardFaceUp ? `face-up:${player.revealedRole}` : "face-down"}</span>
                <span>{player.skipActions > 0 ? "detained" : "free"}</span>
              </li>
            ))}
          </ul>
          {publicState.phase === "lobby" ? (
            <div className="row">
              <button onClick={toggleReady}>{me?.ready ? "Unready" : "Ready"}</button>
              {publicState.hostPlayerId === myPlayerId ? <button onClick={startGame}>Start Game</button> : null}
            </div>
          ) : (
            <div>
              <p>Round {publicState.turn.round}</p>
              <p>Turn: {publicState.players.find((player) => player.id === currentPlayerId)?.name}</p>
            </div>
          )}
          {publicState.winner ? (
            <p className="winner">
              Winner: {publicState.winner.winnerFaction} | {publicState.winner.reason}
            </p>
          ) : null}
        </article>

        <article className="panel">
          <h2>Actions</h2>
          <p>Target: {selectedTarget || "-"}</p>
          <div className="row">
            <button disabled={actionDisabled || !selectedTarget} onClick={doPeek}>
              Peek
            </button>
            <button disabled={actionDisabled || !selectedTarget} onClick={doSwap}>
              Swap
            </button>
            <button disabled={actionDisabled} onClick={doSwapCenter}>
              Swap Center
            </button>
          </div>
          <label>Oracle Prediction</label>
          <select
            value={oraclePrediction}
            onChange={(e) => setOraclePrediction(e.target.value as WinFaction)}
            disabled={actionDisabled}
          >
            <option value="rebels">rebels</option>
            <option value="loyalists">loyalists</option>
          </select>
          <label>Slave Followers (comma ids)</label>
          <input value={followerInput} onChange={(e) => setFollowerInput(e.target.value)} />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={triggerGlobalSwap}
              onChange={(e) => setTriggerGlobalSwap(e.target.checked)}
              disabled={actionDisabled}
            />
            Belly Dancer global swap (if extension enabled)
          </label>
          <button disabled={actionDisabled} onClick={doReveal}>
            Reveal
          </button>
        </article>

        <article className="panel">
          <h2>Private Intel</h2>
          <p>Self role: {privateState?.selfRole}</p>
          <p>Card face: {privateState?.selfCardFaceUp ? "up" : "down"}</p>
          <p>Oracle prediction: {privateState?.oraclePrediction ?? "-"}</p>
          <ul>
            {privateState?.privateKnowledge.map((note, idx) => (
              <li key={`${note.subjectType}-${note.subjectId}-${idx}`}>
                {note.source} saw {note.subjectType}:{note.subjectId} = {note.role}
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Logs</h2>
          <ul>
            {publicState.logs.map((log) => (
              <li key={log.id}>{log.message}</li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Private Feed</h2>
          <ul>
            {privateFeed.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </article>
      </section>

      <ErrorFeed errors={errors} />
    </div>
  );
}

function ErrorFeed(props: { errors: string[] }) {
  if (props.errors.length === 0) {
    return null;
  }
  return (
    <section className="errors">
      {props.errors.map((error, index) => (
        <p key={`${error}-${index}`}>{error}</p>
      ))}
    </section>
  );
}
