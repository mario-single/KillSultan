import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  AckResult,
  ClientToServerEvents,
  PlayerScopedState,
  Role,
  ServerToClientEvents,
  WinFaction,
} from "@sultan/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000";
const BASE_TOKEN_KEY = "sultan_token";
const BASE_ROOM_KEY = "sultan_room_id";
const BASE_NAME_KEY = "sultan_name";
const BACK_ICON = "/assets/roles/back.png";
const LOGO_ICON = "/assets/roles/logo.png";
const LOGO_WIDE = "/assets/roles/logo2.png";

const pageUrl = typeof window === "undefined" ? null : new URL(window.location.href);
const simSlotRaw = pageUrl?.searchParams.get("simSlot") ?? "";
const SIM_SLOT = simSlotRaw.trim().replace(/[^\w-]/g, "");
const SIM_NAME = (pageUrl?.searchParams.get("simName") ?? "").trim();
const SIM_ROOM = (pageUrl?.searchParams.get("simRoom") ?? "").trim().toUpperCase();
const SIM_AUTO_MODE = (pageUrl?.searchParams.get("simAuto") ?? "").trim();
const SIM_AUTO_READY = pageUrl?.searchParams.get("simAutoReady") === "1";
const SIM_AUTO_START = pageUrl?.searchParams.get("simAutoStart") === "1";
const SIM_COMPACT = pageUrl?.searchParams.get("simCompact") === "1";
const SIM_EMBED = pageUrl?.searchParams.get("embed") === "1";

const KEY_SUFFIX = SIM_SLOT ? `_${SIM_SLOT}` : "";
const TOKEN_KEY = `${BASE_TOKEN_KEY}${KEY_SUFFIX}`;
const ROOM_KEY = `${BASE_ROOM_KEY}${KEY_SUFFIX}`;
const NAME_KEY = `${BASE_NAME_KEY}${KEY_SUFFIX}`;

const NOTE_OPTIONS = ["", "疑似苏丹", "疑似刺客", "疑似守卫", "疑似奴隶", "重点观察"] as const;
type NoteText = (typeof NOTE_OPTIONS)[number];

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ROLE_META: Record<Role, { name: string; short: string; icon: string; iconSmall: string }> = {
  sultan: { name: "苏丹", short: "苏", icon: "/assets/roles/sultan.png", iconSmall: "/assets/roles/s_sultan.png" },
  assassin: { name: "刺客", short: "刺", icon: "/assets/roles/assassin.png", iconSmall: "/assets/roles/s_assassin.png" },
  guard: { name: "守卫", short: "卫", icon: "/assets/roles/guard.png", iconSmall: "/assets/roles/s_guard.png" },
  slave: { name: "奴隶", short: "奴", icon: "/assets/roles/slave.png", iconSmall: "/assets/roles/s_slave.png" },
  oracle: { name: "占卜师", short: "卜", icon: "/assets/roles/oracle.png", iconSmall: "/assets/roles/s_oracle.png" },
  belly_dancer: {
    name: "肚皮舞娘",
    short: "舞",
    icon: "/assets/roles/belly_dancer.png",
    iconSmall: "/assets/roles/s_belly_dancer.png",
  },
  slave_trader: {
    name: "奴隶贩子",
    short: "贩",
    icon: "/assets/roles/slave_trader.png",
    iconSmall: "/assets/roles/s_slave_trader.png",
  },
  grand_official: {
    name: "大官",
    short: "官",
    icon: "/assets/roles/grand_official.png",
    iconSmall: "/assets/roles/s_grand_official.png",
  },
};

type RuleGlyphKind = "turn" | "faction" | "victory" | "privacy";

const RULE_CARDS: Array<{ role: Role; title: string; desc: string }> = [
  {
    role: "sultan",
    title: "苏丹（保皇派）",
    desc: "公开身份后，若存活整整一轮保皇派获胜。可处决一名已公开革命角色，不会被守卫拘留。",
  },
  {
    role: "assassin",
    title: "刺客（革命党）",
    desc: "公开时刺杀一名玩家。若刺客或目标相邻位置存在有效守卫，则刺杀失败且刺客死亡。",
  },
  {
    role: "guard",
    title: "守卫（保皇派）",
    desc: "公开时可拘留一名玩家。若目标不是苏丹或守卫，则目标跳过一次行动。刺客刺杀时可被动拦截。",
  },
  {
    role: "slave",
    title: "奴隶（革命党）",
    desc: "公开后可发动起义，相邻奴隶可跟随公开。若形成三张相邻公开奴隶，革命党立即获胜。",
  },
  {
    role: "oracle",
    title: "占卜师（中立）",
    desc: "公开后秘密查看三张牌并选择预言阵营。若该阵营最终获胜，占卜师获胜。",
  },
  {
    role: "belly_dancer",
    title: "肚皮舞娘（中立）",
    desc: "暗置时保皇倾向；公开时革命倾向。公开状态可魅惑相邻守卫，使其失效。",
  },
  {
    role: "slave_trader",
    title: "奴隶贩子（中立）",
    desc: "选择一名玩家，若其为奴隶则拘留并重复技能；若不是奴隶则无事发生，链式效果终止。",
  },
  {
    role: "grand_official",
    title: "大官（中立）",
    desc: "选择一名玩家并强制其执行技能。结算时若你相邻玩家分数和 >= 2，则你额外获胜。",
  },
];

const RULE_BASE: Array<{ title: string; desc: string; icon: RuleGlyphKind }> = [
  { title: "每回合动作", desc: "每位玩家每回合只能执行 1 个动作：偷看 / 交换 / 换中间牌 / 公开。", icon: "turn" },
  { title: "阵营摇摆", desc: "阵营由当前持牌决定，暗牌交换后阵营立即变化。", icon: "faction" },
  {
    title: "胜利条件",
    desc: "革命党：刺客杀苏丹或三奴隶相邻公开；保皇派：苏丹公开存活整轮；中立按角色条件结算。",
    icon: "victory",
  },
  { title: "隐私规则", desc: "暗牌不会广播。偷看、占卜等结果仅推送给拥有权限的玩家。", icon: "privacy" },
];

function unwrapAck<T>(result: AckResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

function factionName(faction: WinFaction): string {
  return faction === "rebels" ? "革命党" : "保皇派";
}

function roleFactionName(role: Role, faceUp: boolean): string {
  if (role === "belly_dancer") {
    return faceUp ? "革命倾向" : "保皇倾向";
  }
  if (role === "assassin" || role === "slave") {
    return "革命党";
  }
  if (role === "sultan" || role === "guard") {
    return "保皇派";
  }
  return "中立";
}

function parseCommaIds(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function toCommaInput(ids: string[]): string {
  return ids.join(",");
}

function areAdjacentSeats(a: number, b: number, total: number): boolean {
  if (total <= 1) {
    return false;
  }
  const diff = Math.abs(a - b);
  return diff === 1 || diff === total - 1;
}

function seatPosition(index: number, total: number): { left: string; top: string } {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(total, 1);
  const radius = total <= 6 ? 34 : total <= 10 ? 39 : 42;
  return {
    left: `${50 + Math.cos(angle) * radius}%`,
    top: `${50 + Math.sin(angle) * radius}%`,
  };
}

function roleNeedTarget(role?: Role): boolean {
  return role === "assassin" || role === "guard" || role === "grand_official";
}

function roleSkillLabel(role?: Role, canFollowUprising = false): string {
  switch (role) {
    case "sultan":
      return "公开身份";
    case "assassin":
      return "刺杀目标";
    case "guard":
      return "拘留目标";
    case "slave":
      return canFollowUprising ? "跟随起义" : "发起起义";
    case "oracle":
      return "公开并占卜";
    case "belly_dancer":
      return "公开身份";
    case "slave_trader":
      return "发动链式筛查";
    case "grand_official":
      return "强制目标执行技能";
    default:
      return "公开身份并触发技能";
  }
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
  const [noteEditorFor, setNoteEditorFor] = useState("");
  const [notesByPlayerId, setNotesByPlayerId] = useState<Record<string, NoteText>>({});
  const [forceSkillTarget, setForceSkillTarget] = useState("");
  const [oraclePrediction, setOraclePrediction] = useState<WinFaction>("rebels");
  const [forceOraclePrediction, setForceOraclePrediction] = useState<WinFaction>("rebels");
  const [slaveTraderTargetsInput, setSlaveTraderTargetsInput] = useState("");
  const [forceSlaveTraderTargetsInput, setForceSlaveTraderTargetsInput] = useState("");
  const [showRuleModal, setShowRuleModal] = useState(false);
  const autoCreateDoneRef = useRef(false);
  const autoJoinCooldownUntilRef = useRef(0);
  const autoJoinInFlightRef = useRef(false);
  const autoReadyCooldownUntilRef = useRef(0);
  const autoStartCooldownUntilRef = useRef(0);

  useEffect(() => {
    const socket: ClientSocket = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("game:state", (nextState) => setScopedState(nextState));
    socket.on("room:update", (publicState) => {
      setScopedState((prev) => (prev ? { publicState, privateState: prev.privateState } : prev));
    });
    socket.on("game:private", (payload) => {
      setPrivateFeed((prev) => [payload.message, ...prev].slice(0, 40));
    });
    socket.on("game:error", (payload) => {
      setErrors((prev) => [`${payload.code}: ${payload.message}`, ...prev].slice(0, 20));
    });
    socket.on("game:over", (nextState) => {
      setScopedState(nextState);
      setPrivateFeed((prev) => ["本局已结束。", ...prev].slice(0, 40));
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
        } catch (error) {
          setErrors((prev) => [`重连失败：${String(error)}`, ...prev].slice(0, 20));
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
  const playersOrdered = useMemo(() => {
    if (!publicState) {
      return [];
    }
    return [...publicState.players].sort((a, b) => a.seatIndex - b.seatIndex);
  }, [publicState]);
  const targetPlayers = playersOrdered.filter((player) => player.id !== myPlayerId);
  const selectedTargetPlayer = targetPlayers.find((player) => player.id === selectedTarget);
  const isMyTurn = currentPlayerId === myPlayerId;
  const me = publicState?.players.find((player) => player.id === myPlayerId);
  const currentActor = playersOrdered.find((player) => player.id === currentPlayerId);
  const myRole = privateState?.selfRole;

  useEffect(() => {
    if (!SIM_AUTO_MODE || publicState) {
      return;
    }
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      return;
    }

    const desiredName = SIM_NAME || (SIM_SLOT ? `模拟玩家-${SIM_SLOT}` : "模拟玩家");
    if (!playerName.trim()) {
      setPlayerName(desiredName);
      localStorage.setItem(NAME_KEY, desiredName);
    }

    if (SIM_AUTO_MODE === "create") {
      if (autoCreateDoneRef.current) {
        return;
      }
      autoCreateDoneRef.current = true;
      socket.emit("room:create", { playerName: desiredName, token: token || undefined }, (result) => {
        if (!result.ok) {
          setErrors((prev) => [`${result.error.code}: ${result.error.message}`, ...prev].slice(0, 20));
          autoCreateDoneRef.current = false;
          return;
        }
        setToken(result.data.token);
        setMyPlayerId(result.data.playerId);
        setRoomIdInput(result.data.roomId);
        localStorage.setItem(TOKEN_KEY, result.data.token);
        localStorage.setItem(ROOM_KEY, result.data.roomId);
        localStorage.setItem(NAME_KEY, desiredName);
      });
      return;
    }

    if (SIM_AUTO_MODE === "join") {
      if (!SIM_ROOM || autoJoinInFlightRef.current || Date.now() < autoJoinCooldownUntilRef.current) {
        return;
      }
      autoJoinInFlightRef.current = true;
      socket.emit(
        "room:join",
        {
          roomId: SIM_ROOM,
          playerName: desiredName,
          token: token || undefined,
        },
        (result) => {
          autoJoinInFlightRef.current = false;
          if (!result.ok) {
            autoJoinCooldownUntilRef.current = Date.now() + 1200;
            return;
          }
          setToken(result.data.token);
          setMyPlayerId(result.data.playerId);
          setRoomIdInput(result.data.roomId);
          localStorage.setItem(TOKEN_KEY, result.data.token);
          localStorage.setItem(ROOM_KEY, result.data.roomId);
          localStorage.setItem(NAME_KEY, desiredName);
        },
      );
    }
  }, [playerName, publicState, token]);

  useEffect(() => {
    if (!publicState || !me || !socketRef.current || publicState.phase !== "lobby") {
      return;
    }

    const socket = socketRef.current;

    if (SIM_AUTO_READY && !me.ready && Date.now() >= autoReadyCooldownUntilRef.current) {
      autoReadyCooldownUntilRef.current = Date.now() + 600;
      socket.emit("room:ready", { roomId: publicState.roomId, ready: true }, () => undefined);
    }

    if (SIM_AUTO_START && publicState.hostPlayerId === myPlayerId && Date.now() >= autoStartCooldownUntilRef.current) {
      const canStart = publicState.players.length >= 5 && publicState.players.every((player) => player.ready);
      if (canStart) {
        autoStartCooldownUntilRef.current = Date.now() + 1200;
        socket.emit("game:start", { roomId: publicState.roomId }, () => undefined);
      }
    }
  }, [me, myPlayerId, publicState]);

  const noteStorageKey = publicState && myPlayerId ? `killsultan_notes_${publicState.roomId}_${myPlayerId}` : "";

  useEffect(() => {
    if (!noteStorageKey) {
      return;
    }
    const raw = localStorage.getItem(noteStorageKey);
    if (!raw) {
      setNotesByPlayerId({});
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, NoteText>;
      setNotesByPlayerId(parsed);
    } catch {
      setNotesByPlayerId({});
    }
  }, [noteStorageKey]);

  useEffect(() => {
    if (!noteStorageKey) {
      return;
    }
    localStorage.setItem(noteStorageKey, JSON.stringify(notesByPlayerId));
  }, [noteStorageKey, notesByPlayerId]);

  useEffect(() => {
    if (!publicState) {
      return;
    }
    setNotesByPlayerId((prev) => {
      const allowed = new Set(publicState.players.map((player) => player.id));
      const next: Record<string, NoteText> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (allowed.has(key)) {
          next[key] = value;
        }
      }
      return next;
    });
  }, [publicState]);

  function addError(message: string): void {
    setErrors((prev) => [message, ...prev].slice(0, 20));
  }

  function openSeatOverlay(playerId: string): void {
    if (playerId !== myPlayerId) {
      setSelectedTarget(playerId);
    }
    setNoteEditorFor((prev) => (prev === playerId ? "" : playerId));
  }

  function setSeatNote(playerId: string, note: NoteText): void {
    setNotesByPlayerId((prev) => {
      const next = { ...prev };
      if (!note) {
        delete next[playerId];
      } else {
        next[playerId] = note;
      }
      return next;
    });
  }

  function toggleCsvId(csv: string, id: string, setter: (next: string) => void): void {
    const current = parseCommaIds(csv);
    if (current.includes(id)) {
      setter(toCommaInput(current.filter((item) => item !== id)));
      return;
    }
    setter(toCommaInput([...current, id]));
  }

  function addSelectedTargetToCsv(csv: string, setter: (next: string) => void): void {
    if (!selectedTarget) {
      return;
    }
    const current = parseCommaIds(csv);
    if (current.includes(selectedTarget)) {
      return;
    }
    setter(toCommaInput([...current, selectedTarget]));
  }

  function createRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (!playerName.trim()) {
      addError("请输入昵称。");
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
      } catch (error) {
        addError(String(error));
      }
    });
  }

  function joinRoom(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (!playerName.trim()) {
      addError("请输入昵称。");
      return;
    }
    if (!roomIdInput.trim()) {
      addError("请输入房间号。");
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
        } catch (error) {
          addError(String(error));
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
    if (!socket || !publicState || !myRole) {
      return;
    }
    const slaveTraderTargets = parseCommaIds(slaveTraderTargetsInput);
    const forceSlaveTraderTargets = parseCommaIds(forceSlaveTraderTargetsInput);

    const sultanExecution = myRole === "sultan" && !!privateState?.selfCardFaceUp;
    if ((roleNeedTarget(myRole) || sultanExecution) && !selectedTarget) {
      addError("请先选择目标玩家。");
      return;
    }

    const payload: any = {
      roomId: publicState.roomId,
    };

    switch (myRole) {
      case "sultan":
        payload.targetPlayerId = selectedTarget || undefined;
        break;
      case "assassin":
      case "guard":
        payload.targetPlayerId = selectedTarget;
        break;
      case "slave":
        payload.followerIds = undefined;
        break;
      case "oracle":
        payload.oraclePrediction = oraclePrediction;
        break;
      case "slave_trader":
        payload.slaveTraderTargets = slaveTraderTargets.length > 0 ? slaveTraderTargets : undefined;
        break;
      case "grand_official":
        payload.targetPlayerId = selectedTarget;
        payload.forceSkill = {
          targetPlayerId: forceSkillTarget || undefined,
          slaveTraderTargets: forceSlaveTraderTargets.length > 0 ? forceSlaveTraderTargets : undefined,
          oraclePrediction: forceOraclePrediction,
        };
        break;
      default:
        break;
    }

    socket.emit(
      "action:reveal",
      payload,
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
    socket.emit("room:leave", { roomId: publicState.roomId }, () => {
      setScopedState(null);
      setMyPlayerId("");
      setSelectedTarget("");
      setNoteEditorFor("");
      setForceSkillTarget("");
      setSlaveTraderTargetsInput("");
      setForceSlaveTraderTargetsInput("");
      localStorage.removeItem(ROOM_KEY);
    });
  }

  if (!publicState) {
    const shellClassName = `shell${SIM_COMPACT ? " shell-compact" : ""}${SIM_EMBED ? " shell-embed" : ""}`;
    return (
      <div className={shellClassName}>
        <div className="hero">
          <img className="hero-logo" src={LOGO_ICON} alt="刺杀苏丹王 Logo" />
          <p className="hero-badge">多人实时策略 · 身份隐藏 · 阵营摇摆</p>
          <h1>刺杀苏丹王 KillSultan</h1>
          <p>输入昵称即可开房，邀请朋友输入房间号加入。</p>
        </div>
        <div className="card lobby-card">
          <label>你的昵称</label>
          <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="例如：夜行刺客" />
          <label>房间号（加入时填写）</label>
          <input
            value={roomIdInput}
            onChange={(e) => setRoomIdInput(e.target.value.toUpperCase())}
            placeholder="例如：AB12CD"
          />
          <div className="row">
            <button onClick={createRoom}>创建房间</button>
            <button className="btn-secondary" onClick={joinRoom}>
              加入房间
            </button>
            <button className="btn-outline" onClick={() => setShowRuleModal(true)}>
              查看规则
            </button>
          </div>
        </div>
        <ErrorPanel errors={errors} />
        <RuleModal open={showRuleModal} onClose={() => setShowRuleModal(false)} />
      </div>
    );
  }

  const actionDisabled = publicState.phase !== "in_game" || !isMyTurn || !me?.alive || (me?.skipActions ?? 0) > 0;
  const myRoleMeta = myRole ? ROLE_META[myRole] : undefined;
  const canAnytimeCrown =
    myRole === "sultan" &&
    publicState.phase === "in_game" &&
    !!me?.alive &&
    !privateState?.selfCardFaceUp;
  const revealNeedTarget = roleNeedTarget(myRole) || (myRole === "sultan" && !!privateState?.selfCardFaceUp);
  const revealDisabled = canAnytimeCrown ? false : actionDisabled || (revealNeedTarget && !selectedTarget);
  const revealLabel =
    myRole === "sultan"
      ? privateState?.selfCardFaceUp
        ? "处决目标（苏丹回合）"
        : "公开身份（可随时）"
      : roleSkillLabel(myRole, false);
  const canFollowUprising =
    myRole === "slave" &&
    !!me &&
    me.alive &&
    !privateState?.selfCardFaceUp &&
    playersOrdered.some(
      (player) =>
        player.alive &&
        player.revealedRole === "slave" &&
        areAdjacentSeats(player.seatIndex, me.seatIndex, playersOrdered.length),
    );
  const shellClassName = `shell${SIM_COMPACT ? " shell-compact" : ""}${SIM_EMBED ? " shell-embed" : ""}`;

  return (
    <div className={shellClassName}>
      <header className="topbar">
        <div className="game-head">
          <img className="game-logo-wide" src={LOGO_WIDE} alt="刺杀苏丹王" />
          <h1>房间 {publicState.roomId}</h1>
          <p className="topbar-sub">
            阶段：{publicState.phase === "lobby" ? "准备阶段" : publicState.phase === "in_game" ? "游戏中" : "已结束"}
          </p>
        </div>
        <div className="topbar-meta">
          <span>你是：{me?.name}</span>
          <button className="btn-outline" onClick={() => setShowRuleModal(true)}>
            查看规则
          </button>
          <button className="btn-secondary" onClick={leaveRoom}>
            退出房间
          </button>
        </div>
      </header>

      <section className="play-layout">
        <article className="panel table-panel">
          <div className="table-panel-head">
            <h2>圆桌显示区</h2>
            <p>点击头像可选目标并备注，当前行动玩家高亮</p>
          </div>
          {publicState.phase === "lobby" ? (
            <div className="ready-overview">
              {playersOrdered.map((player) => (
                <span key={`ready-${player.id}`} className={`ready-pill ${player.ready ? "is-ready" : "is-pending"}`}>
                  #{player.seatIndex + 1} {player.name} · {player.ready ? "已准备" : "未准备"}
                </span>
              ))}
            </div>
          ) : null}
          <div className="round-table">
            <div className="table-center">
              <p>第 {publicState.turn.round} 轮</p>
              <p>当前行动：{currentActor?.name ?? "-"}</p>
            </div>
            {playersOrdered.map((player, index) => {
              const revealedRole = player.revealedRole;
              const current = player.id === currentPlayerId;
              const selected = player.id === selectedTarget;
              const isSelf = player.id === myPlayerId;
              const note = notesByPlayerId[player.id];
              const showFront = player.alive && !!revealedRole;

              return (
                <div key={player.id} className="seat-wrap" style={seatPosition(index, playersOrdered.length)}>
                  <button
                    className={`seat-btn ${current ? "current" : ""} ${selected ? "selected" : ""} ${!player.alive ? "dead" : ""}`}
                    onClick={() => openSeatOverlay(player.id)}
                  >
                    <div className={`seat-card ${showFront ? "front" : "back"}`}>
                      {showFront && revealedRole ? (
                        <img src={ROLE_META[revealedRole].iconSmall} alt={ROLE_META[revealedRole].name} />
                      ) : (
                        <img src={BACK_ICON} alt="卡背" />
                      )}
                    </div>
                  </button>
                  <div className="seat-label">
                    <strong>
                      #{player.seatIndex + 1} {player.name}
                    </strong>
                    <span>{isSelf ? "你" : "玩家"} · {showFront ? "正面" : player.alive ? "背面" : "阵亡背面"}</span>
                  </div>
                  {current ? <span className="seat-current-tag">行动中</span> : null}
                  {selected && !isSelf ? <span className="seat-target-tag">目标</span> : null}
                  {note ? <span className="seat-note-tag">{note}</span> : null}
                  {publicState.phase === "lobby" ? (
                    <span className={player.ready ? "seat-ready-tag" : "seat-unready-tag"}>
                      {player.ready ? "已准备" : "未准备"}
                    </span>
                  ) : null}
                  {noteEditorFor === player.id ? (
                    <div className="seat-note-pop">
                      {NOTE_OPTIONS.map((option) => (
                        <button
                          key={option || "clear"}
                          className={`note-btn ${option && option === note ? "active" : ""}`}
                          onClick={() => {
                            setSeatNote(player.id, option);
                            if (!isSelf) {
                              setSelectedTarget(player.id);
                            }
                            setNoteEditorFor("");
                          }}
                        >
                          {option || "清空"}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {publicState.phase === "lobby" ? (
            <div className="row">
              <button onClick={toggleReady}>{me?.ready ? "取消准备" : "准备"}</button>
              {publicState.hostPlayerId === myPlayerId ? (
                <button className="btn-secondary" onClick={startGame}>
                  开始游戏
                </button>
              ) : null}
            </div>
          ) : null}
        </article>

        <aside className="ops-sidebar">
          <article className="panel panel-role">
            <h2>我的身份</h2>
            {myRole && myRoleMeta ? (
              <div className="my-role-card">
                <RoleAvatar role={myRole} label={myRoleMeta.short} size="xl" />
                <div>
                  <p className="role-name">{myRoleMeta.name}</p>
                  <p className="role-faction">
                    {roleFactionName(myRole, Boolean(privateState?.selfCardFaceUp))}
                    {privateState?.selfCardFaceUp ? " · 已公开" : " · 暗置"}
                  </p>
                </div>
              </div>
            ) : (
              <p>尚未分配身份。</p>
            )}
            <div className="turn-box">
              <p>{isMyTurn ? "现在轮到你行动。" : "请等待其他玩家行动。"}</p>
              <p>状态：{me?.alive ? "存活" : "阵亡"}</p>
              <p>拘留：{(me?.skipActions ?? 0) > 0 ? `剩余 ${me?.skipActions} 次` : "无"}</p>
            </div>
          </article>

          <article className="panel">
            <h2>通用动作</h2>
            <select value={selectedTarget} onChange={(e) => setSelectedTarget(e.target.value)}>
              <option value="">-- 选择目标 --</option>
              {targetPlayers.map((player) => (
                <option key={player.id} value={player.id}>
                  #{player.seatIndex + 1} {player.name}
                </option>
              ))}
            </select>
            <p className="tip">当前目标：{selectedTargetPlayer ? selectedTargetPlayer.name : "未选择"}</p>
            <div className="row">
              <button disabled={actionDisabled || !selectedTarget} onClick={doPeek}>
                偷看
              </button>
              <button disabled={actionDisabled || !selectedTarget} onClick={doSwap}>
                交换
              </button>
              <button disabled={actionDisabled} onClick={doSwapCenter}>
                换中间牌
              </button>
            </div>
          </article>

          <article className="panel skill-panel">
            <h2>身份技能</h2>
            <p className="skill-title">{revealLabel}</p>
            {myRole ? (
              <div className="skill-hero">
                <img className="skill-hero-art" src={ROLE_META[myRole].icon} alt={`${ROLE_META[myRole].name}角色图`} />
                <div className="skill-hero-meta">
                  <span className="skill-hero-role">{ROLE_META[myRole].name}</span>
                  <span className="skill-hero-tip">{roleFactionName(myRole, Boolean(privateState?.selfCardFaceUp))}</span>
                </div>
                <div className="skill-hero-glyph">
                  <RoleGlyph role={myRole} size={36} />
                </div>
              </div>
            ) : null}
            {myRole === "oracle" ? (
              <>
                <label>预测阵营</label>
                <select value={oraclePrediction} onChange={(e) => setOraclePrediction(e.target.value as WinFaction)}>
                  <option value="rebels">革命党</option>
                  <option value="loyalists">保皇派</option>
                </select>
              </>
            ) : null}
            {myRole === "slave" ? (
              <p className="tip">{canFollowUprising ? "你满足跟随起义条件，可直接跟随。" : "你可直接发起起义。"}</p>
            ) : null}
            {myRole === "slave_trader" ? (
              <>
                <label>链式目标列表</label>
                <input
                  value={slaveTraderTargetsInput}
                  onChange={(e) => setSlaveTraderTargetsInput(e.target.value)}
                  placeholder="逗号分隔，或追加当前目标"
                />
                <div className="row">
                  <button onClick={() => addSelectedTargetToCsv(slaveTraderTargetsInput, setSlaveTraderTargetsInput)}>追加当前目标</button>
                  <button className="btn-outline" onClick={() => setSlaveTraderTargetsInput("")}>
                    清空
                  </button>
                </div>
              </>
            ) : null}
            {myRole === "grand_official" ? (
              <>
                <label>强制技能二级目标（可选）</label>
                <select value={forceSkillTarget} onChange={(e) => setForceSkillTarget(e.target.value)}>
                  <option value="">-- 不设置 --</option>
                  {targetPlayers.map((player) => (
                    <option key={player.id} value={player.id}>
                      #{player.seatIndex + 1} {player.name}
                    </option>
                  ))}
                </select>
                <label>强制占卜阵营</label>
                <select value={forceOraclePrediction} onChange={(e) => setForceOraclePrediction(e.target.value as WinFaction)}>
                  <option value="rebels">革命党</option>
                  <option value="loyalists">保皇派</option>
                </select>
                <label>强制-奴隶贩子链式目标</label>
                <input
                  value={forceSlaveTraderTargetsInput}
                  onChange={(e) => setForceSlaveTraderTargetsInput(e.target.value)}
                  placeholder="逗号分隔，或追加当前目标"
                />
                <div className="row">
                  <button onClick={() => addSelectedTargetToCsv(forceSlaveTraderTargetsInput, setForceSlaveTraderTargetsInput)}>追加当前目标</button>
                  <button className="btn-outline" onClick={() => setForceSlaveTraderTargetsInput("")}>
                    清空
                  </button>
                </div>
              </>
            ) : null}
            {roleNeedTarget(myRole) ? <p className="tip">该技能需要先选择目标。</p> : null}
            <button disabled={revealDisabled} className={myRole === "assassin" ? "skill-fire is-kill" : "skill-fire"} onClick={doReveal}>
              {revealLabel}
            </button>
          </article>

          <article className="panel">
            <h2>私密情报</h2>
            <p>当前身份：{myRole ? ROLE_META[myRole].name : "-"}</p>
            <p>牌面状态：{privateState?.selfCardFaceUp ? "已公开" : "暗置"}</p>
            <p>占卜选择：{privateState?.oraclePrediction ? factionName(privateState.oraclePrediction) : "-"}</p>
            <ul className="text-list">
              {privateState?.privateKnowledge.map((note, index) => (
                <li key={`${note.subjectType}-${note.subjectId}-${index}`}>
                  {note.source === "peek" ? "偷看" : "占卜"}看到
                  {note.subjectType === "center" ? "中间牌" : `玩家 ${note.subjectId}`}为
                  {ROLE_META[note.role].name}
                </li>
              ))}
            </ul>
          </article>

          <article className="panel">
            <h2>行动日志</h2>
            <ul className="text-list">
              {publicState.logs.map((log) => (
                <li key={log.id}>{log.message}</li>
              ))}
            </ul>
          </article>

          <article className="panel">
            <h2>私密提示</h2>
            <ul className="text-list">
              {privateFeed.map((line, index) => (
                <li key={`${line}-${index}`}>{line}</li>
              ))}
            </ul>
          </article>
        </aside>
      </section>

      <ErrorPanel errors={errors} />
      <RuleModal open={showRuleModal} onClose={() => setShowRuleModal(false)} />
    </div>
  );
}

function RoleGlyph(props: { role: Role; size?: number }) {
  const size = props.size ?? 24;
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (props.role) {
    case "sultan":
      return (
        <svg className="role-glyph role-glyph-sultan" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M4 17h16l-1.7-8-3.3 3.2-3-5-3 5L5.7 9z" />
          <path {...common} d="M6 20h12" />
        </svg>
      );
    case "assassin":
      return (
        <svg className="role-glyph role-glyph-assassin" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M5 19l4.8-4.8" />
          <path {...common} d="M9.8 14.2 19.5 4.5 21 6l-9.7 9.7" />
          <path {...common} d="M13.2 7.8 16.2 10.8" />
        </svg>
      );
    case "guard":
      return (
        <svg className="role-glyph role-glyph-guard" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M12 3l7 3v5c0 5-3.3 8-7 10-3.7-2-7-5-7-10V6z" />
        </svg>
      );
    case "slave":
      return (
        <svg className="role-glyph role-glyph-slave" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M8.2 8.2a3 3 0 0 1 4.2 0l1.4 1.4a3 3 0 0 1 0 4.2" />
          <path {...common} d="M15.8 15.8a3 3 0 0 1-4.2 0l-1.4-1.4a3 3 0 0 1 0-4.2" />
        </svg>
      );
    case "oracle":
      return (
        <svg className="role-glyph role-glyph-oracle" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M2.5 12s3.5-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.5 5.5-9.5 5.5S2.5 12 2.5 12z" />
          <circle {...common} cx="12" cy="12" r="2.4" />
        </svg>
      );
    case "belly_dancer":
      return (
        <svg
          className="role-glyph role-glyph-belly-dancer"
          width={size}
          height={size}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path {...common} d="M5 13c2.2-4.2 6.3-6 9-4.4 2.9 1.7 2.8 5.5-.1 7.3-2.6 1.6-5.9.8-7.7-1.1" />
          <circle {...common} cx="16.5" cy="6.5" r="1.6" />
        </svg>
      );
    case "slave_trader":
      return (
        <svg className="role-glyph role-glyph-slave-trader" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M12 4v13" />
          <path {...common} d="M6 7h12" />
          <path {...common} d="M8 7 5.5 11h5z" />
          <path {...common} d="M16 7 13.5 11h5z" />
          <path {...common} d="M8 18h8" />
        </svg>
      );
    case "grand_official":
      return (
        <svg className="role-glyph role-glyph-grand-official" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect {...common} x="5" y="6" width="10" height="7" rx="1.5" />
          <path {...common} d="M15 9h4" />
          <path {...common} d="M9 13v5" />
          <path {...common} d="M7 20h10" />
        </svg>
      );
    default:
      return null;
  }
}

function RuleGlyph(props: { kind: RuleGlyphKind; size?: number }) {
  const size = props.size ?? 20;
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (props.kind) {
    case "turn":
      return (
        <svg className="rule-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M12 4a8 8 0 1 0 7.5 10" />
          <path {...common} d="M12 4h4v4" />
        </svg>
      );
    case "faction":
      return (
        <svg className="rule-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M4 8h8l-2-2" />
          <path {...common} d="M20 16h-8l2 2" />
          <path {...common} d="M12 6v12" />
        </svg>
      );
    case "victory":
      return (
        <svg className="rule-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M8 4h8v3a4 4 0 0 1-8 0z" />
          <path {...common} d="M8 6H5a2 2 0 0 0 2 3h1" />
          <path {...common} d="M16 6h3a2 2 0 0 1-2 3h-1" />
          <path {...common} d="M12 11v4" />
          <path {...common} d="M8 19h8" />
        </svg>
      );
    case "privacy":
      return (
        <svg className="rule-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect {...common} x="6" y="10" width="12" height="9" rx="2" />
          <path {...common} d="M9 10V8a3 3 0 0 1 6 0v2" />
          <circle {...common} cx="12" cy="14.5" r="1.2" />
        </svg>
      );
    default:
      return null;
  }
}

function RoleAvatar(props: { role: Role; label: string; size: "sm" | "xl" }) {
  const [failed, setFailed] = useState(false);
  const meta = ROLE_META[props.role];
  const iconPath = props.size === "sm" ? meta.iconSmall : meta.icon;
  return (
    <div className={`role-avatar ${props.size === "xl" ? "xl" : "sm"}`}>
      {!failed ? (
        <img src={iconPath} alt={meta.name} onError={() => setFailed(true)} />
      ) : (
        <span>{props.label}</span>
      )}
    </div>
  );
}

function ErrorPanel(props: { errors: string[] }) {
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

function RuleModal(props: { open: boolean; onClose: () => void }) {
  if (!props.open) {
    return null;
  }
  return (
    <div className="rulebook-mask" onClick={props.onClose}>
      <section className="rulebook-modal" onClick={(event) => event.stopPropagation()}>
        <header className="rulebook-head">
          <h3>游戏规则说明</h3>
          <div className="row">
            <a className="btn-outline link-btn" href="/docs/玩家规则手册.md" target="_blank" rel="noreferrer">
              打开 Markdown
            </a>
            <a className="btn-outline link-btn" href="/docs/玩家规则手册.docx" target="_blank" rel="noreferrer">
              打开 DOCX
            </a>
            <button className="btn-outline" onClick={props.onClose}>
              关闭
            </button>
          </div>
        </header>
        <div className="rulebook-body">
          <h4>核心规则</h4>
          <div className="rule-grid">
            {RULE_BASE.map((item) => (
              <article key={item.title} className="rule-card">
                <div className="rule-card-head">
                  <RuleGlyph kind={item.icon} size={18} />
                  <strong>{item.title}</strong>
                </div>
                <p>{item.desc}</p>
              </article>
            ))}
          </div>
          <h4>角色技能（共 8 角色，其中中立 4 张）</h4>
          <div className="rule-grid">
            {RULE_CARDS.map((item) => (
              <article key={item.title} className="rule-card rule-card-role">
                <div className="rule-card-head">
                  <img
                    className="rule-role-image"
                    src={ROLE_META[item.role].iconSmall}
                    alt={`${ROLE_META[item.role].name}小图标`}
                  />
                  <RoleGlyph role={item.role} size={18} />
                  <strong>{item.title}</strong>
                </div>
                <p>{item.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
