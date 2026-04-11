import { useEffect, useRef, useState } from "react";
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
const TOKEN_KEY = "sultan_token";
const ROOM_KEY = "sultan_room_id";
const NAME_KEY = "sultan_name";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ROLE_META: Record<Role, { name: string; short: string; icon: string }> = {
  sultan: { name: "苏丹", short: "苏", icon: "/assets/roles/sultan.png" },
  assassin: { name: "刺客", short: "刺", icon: "/assets/roles/assassin.png" },
  guard: { name: "守卫", short: "卫", icon: "/assets/roles/guard.png" },
  slave: { name: "奴隶", short: "奴", icon: "/assets/roles/slave.png" },
  oracle: { name: "占卜师", short: "卜", icon: "/assets/roles/oracle.png" },
  belly_dancer: { name: "肚皮舞娘", short: "舞", icon: "/assets/roles/belly_dancer.png" },
  slave_trader: { name: "奴隶贩子", short: "贩", icon: "/assets/roles/slave_trader.png" },
  grand_official: { name: "大官", short: "官", icon: "/assets/roles/grand_official.png" },
};

const RULE_CARDS: Array<{ title: string; desc: string }> = [
  { title: "苏丹（保皇派）", desc: "公开后加冕；存活整整一轮保皇派获胜。可处决一名已公开革命角色，不会被守卫拘留。" },
  {
    title: "刺客（革命党）",
    desc: "公开时刺杀一名玩家。若刺客或目标相邻位置存在有效守卫，则刺杀失败且刺客死亡。",
  },
  {
    title: "守卫（保皇派）",
    desc: "公开时可拘留一名玩家。若目标不是苏丹或守卫，则目标跳过一次行动。刺客刺杀时可被动拦截。",
  },
  {
    title: "奴隶（革命党）",
    desc: "公开后可发动起义，相邻奴隶可跟随公开。若形成三张相邻公开奴隶，革命党立即获胜。",
  },
  {
    title: "占卜师（中立）",
    desc: "公开后秘密查看三张牌并选择预言阵营。若该阵营最终获胜，占卜师获胜。",
  },
  {
    title: "肚皮舞娘（中立）",
    desc: "暗置时保皇倾向；公开时革命倾向。公开状态可魅惑相邻守卫，使其失效。",
  },
  {
    title: "奴隶贩子（中立）",
    desc: "选择一名玩家，若其为奴隶则拘留并重复技能；若不是奴隶则无事发生，链式效果终止。",
  },
  {
    title: "大官（中立）",
    desc: "选择一名玩家并强制其执行技能。结算时若你相邻玩家分数和 >= 2，则你额外获胜。",
  },
];

const RULE_BASE: Array<{ title: string; desc: string }> = [
  { title: "每回合动作", desc: "每位玩家每回合只能执行 1 个动作：偷看 / 交换 / 换中间牌 / 公开。" },
  { title: "阵营摇摆", desc: "阵营由当前持牌决定，暗牌交换后阵营立即变化。" },
  { title: "胜利条件", desc: "革命党：刺客杀苏丹或三奴隶相邻公开；保皇派：苏丹公开存活整轮；中立按角色条件结算。" },
  { title: "隐私规则", desc: "暗牌不会广播。偷看、占卜等结果仅推送给拥有权限的玩家。" },
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
  const [forceSkillTarget, setForceSkillTarget] = useState("");
  const [oraclePrediction, setOraclePrediction] = useState<WinFaction>("rebels");
  const [forceOraclePrediction, setForceOraclePrediction] = useState<WinFaction>("rebels");
  const [followerInput, setFollowerInput] = useState("");
  const [slaveTraderTargetsInput, setSlaveTraderTargetsInput] = useState("");
  const [forceSlaveTraderTargetsInput, setForceSlaveTraderTargetsInput] = useState("");
  const [showRuleModal, setShowRuleModal] = useState(false);

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
  const isMyTurn = currentPlayerId === myPlayerId;
  const me = publicState?.players.find((player) => player.id === myPlayerId);
  const currentActor = publicState?.players.find((player) => player.id === currentPlayerId);

  function addError(message: string): void {
    setErrors((prev) => [message, ...prev].slice(0, 20));
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
    if (!socket || !publicState) {
      return;
    }
    const followers = parseCommaIds(followerInput);
    const slaveTraderTargets = parseCommaIds(slaveTraderTargetsInput);
    const forceSlaveTraderTargets = parseCommaIds(forceSlaveTraderTargetsInput);

    socket.emit(
      "action:reveal",
      {
        roomId: publicState.roomId,
        targetPlayerId: selectedTarget || undefined,
        followerIds: followers.length > 0 ? followers : undefined,
        slaveTraderTargets: slaveTraderTargets.length > 0 ? slaveTraderTargets : undefined,
        oraclePrediction,
        forceSkill: {
          targetPlayerId: forceSkillTarget || undefined,
          followerIds: followers.length > 0 ? followers : undefined,
          slaveTraderTargets: forceSlaveTraderTargets.length > 0 ? forceSlaveTraderTargets : undefined,
          oraclePrediction: forceOraclePrediction,
        },
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
    socket.emit("room:leave", { roomId: publicState.roomId }, () => {
      setScopedState(null);
      setMyPlayerId("");
      setSelectedTarget("");
      setForceSkillTarget("");
      localStorage.removeItem(ROOM_KEY);
    });
  }

  if (!publicState) {
    return (
      <div className="shell">
        <div className="hero">
          <p className="hero-badge">多人实时策略 · 身份隐藏 · 阵营摇摆</p>
          <h1>杀死苏丹 Online</h1>
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

  const actionDisabled = publicState.phase !== "in_game" || !isMyTurn;
  const myRole = privateState?.selfRole;
  const myRoleMeta = myRole ? ROLE_META[myRole] : undefined;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
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

      <section className="grid">
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
          {publicState.phase === "in_game" ? (
            <div className="turn-box">
              <p>第 {publicState.turn.round} 轮</p>
              <p>当前行动：{currentActor?.name ?? "-"}</p>
              <p>{isMyTurn ? "现在轮到你行动。" : "请等待其他玩家行动。"}</p>
            </div>
          ) : null}
          {publicState.winner ? (
            <p className="winner">
              胜利阵营：{factionName(publicState.winner.winnerFaction)} | {publicState.winner.reason}
            </p>
          ) : null}
        </article>

        <article className="panel">
          <h2>玩家席位</h2>
          <div className="players-grid">
            {publicState.players.map((player) => {
              const revealedRole = player.revealedRole;
              const current = player.id === currentPlayerId;
              const selected = player.id === selectedTarget;
              return (
                <button
                  key={player.id}
                  className={`player-card ${current ? "current" : ""} ${selected ? "selected" : ""}`}
                  onClick={() => setSelectedTarget(player.id)}
                >
                  <div className="player-head">
                    <strong>{player.name}</strong>
                    <span>{player.id === myPlayerId ? "我" : `座位${player.seatIndex + 1}`}</span>
                  </div>
                  <div className="player-role">
                    {revealedRole ? (
                      <>
                        <RoleAvatar role={revealedRole} label={ROLE_META[revealedRole].short} size="sm" />
                        <span>{ROLE_META[revealedRole].name}</span>
                      </>
                    ) : (
                      <span>暗置身份</span>
                    )}
                  </div>
                </button>
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

        <article className="panel">
          <h2>行动面板</h2>
          <p className="tip">当前目标：{selectedTarget || "未选择"}</p>
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
          <label>占卜阵营（占卜师）</label>
          <select value={oraclePrediction} onChange={(e) => setOraclePrediction(e.target.value as WinFaction)} disabled={actionDisabled}>
            <option value="rebels">革命党</option>
            <option value="loyalists">保皇派</option>
          </select>
          <label>奴隶跟随者 ID（逗号分隔）</label>
          <input value={followerInput} onChange={(e) => setFollowerInput(e.target.value)} placeholder="a1,b2" />
          <label>奴隶贩子链式目标 ID（逗号分隔）</label>
          <input value={slaveTraderTargetsInput} onChange={(e) => setSlaveTraderTargetsInput(e.target.value)} placeholder="x1,x2,x3" />
          <label>大官强制技能目标 ID</label>
          <input value={forceSkillTarget} onChange={(e) => setForceSkillTarget(e.target.value)} placeholder="被强制技能作用的二级目标" />
          <label>大官强制占卜阵营</label>
          <select
            value={forceOraclePrediction}
            onChange={(e) => setForceOraclePrediction(e.target.value as WinFaction)}
            disabled={actionDisabled}
          >
            <option value="rebels">革命党</option>
            <option value="loyalists">保皇派</option>
          </select>
          <label>大官强制-奴隶贩子链式目标</label>
          <input
            value={forceSlaveTraderTargetsInput}
            onChange={(e) => setForceSlaveTraderTargetsInput(e.target.value)}
            placeholder="x1,x2"
          />
          <button disabled={actionDisabled} onClick={doReveal}>
            公开身份并触发技能
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
      </section>

      <ErrorPanel errors={errors} />
      <RuleModal open={showRuleModal} onClose={() => setShowRuleModal(false)} />
    </div>
  );
}

function RoleAvatar(props: { role: Role; label: string; size: "sm" | "xl" }) {
  const [failed, setFailed] = useState(false);
  const meta = ROLE_META[props.role];
  return (
    <div className={`role-avatar ${props.size === "xl" ? "xl" : "sm"}`}>
      {!failed ? (
        <img src={meta.icon} alt={meta.name} onError={() => setFailed(true)} />
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
                <strong>{item.title}</strong>
                <p>{item.desc}</p>
              </article>
            ))}
          </div>
          <h4>角色技能（共 8 角色，其中中立 4 张）</h4>
          <div className="rule-grid">
            {RULE_CARDS.map((item) => (
              <article key={item.title} className="rule-card">
                <strong>{item.title}</strong>
                <p>{item.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
