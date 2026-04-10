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

const ROLE_META: Record<
  Role,
  {
    中文名: string;
    缩写: string;
    图标: string;
  }
> = {
  sultan: { 中文名: "苏丹", 缩写: "苏", 图标: "/assets/roles/sultan.png" },
  assassin: { 中文名: "刺客", 缩写: "刺", 图标: "/assets/roles/assassin.png" },
  guard: { 中文名: "守卫", 缩写: "卫", 图标: "/assets/roles/guard.png" },
  slave: { 中文名: "奴隶", 缩写: "奴", 图标: "/assets/roles/slave.png" },
  oracle: { 中文名: "占卜师", 缩写: "卜", 图标: "/assets/roles/oracle.png" },
  belly_dancer: { 中文名: "肚皮舞娘", 缩写: "舞", 图标: "/assets/roles/belly_dancer.png" },
};

function unwrapAck<T>(result: AckResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

function 阵营中文(阵营: WinFaction): string {
  return 阵营 === "rebels" ? "革命党" : "保皇派";
}

function 角色阵营中文(role: Role, faceUp: boolean): string {
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

function 情报来源中文(source: "peek" | "oracle"): string {
  return source === "peek" ? "偷看" : "占卜";
}

export function App() {
  const socketRef = useRef<ClientSocket | null>(null);

  const [玩家名, set玩家名] = useState(localStorage.getItem(NAME_KEY) ?? "");
  const [房间号输入, set房间号输入] = useState(localStorage.getItem(ROOM_KEY) ?? "");
  const [token, setToken] = useState(localStorage.getItem(TOKEN_KEY) ?? "");
  const [我的玩家ID, set我的玩家ID] = useState<string>("");
  const [作用域状态, set作用域状态] = useState<PlayerScopedState | null>(null);
  const [错误列表, set错误列表] = useState<string[]>([]);
  const [私密动态, set私密动态] = useState<string[]>([]);

  const [选中目标, set选中目标] = useState("");
  const [占卜阵营, set占卜阵营] = useState<WinFaction>("rebels");
  const [跟随者输入, set跟随者输入] = useState("");
  const [触发全场交换, set触发全场交换] = useState(false);

  useEffect(() => {
    const socket: ClientSocket = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("game:state", (nextState) => {
      set作用域状态(nextState);
    });

    socket.on("room:update", (公开状态) => {
      set作用域状态((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          publicState: 公开状态,
          privateState: prev.privateState,
        };
      });
    });

    socket.on("game:private", (payload) => {
      set私密动态((prev) => [payload.message, ...prev].slice(0, 40));
    });

    socket.on("game:error", (payload) => {
      set错误列表((prev) => [`${payload.code}: ${payload.message}`, ...prev].slice(0, 20));
    });

    socket.on("game:over", (nextState) => {
      set作用域状态(nextState);
      set私密动态((prev) => ["本局已结束。", ...prev].slice(0, 40));
    });

    socket.on("connect", () => {
      const 本地Token = localStorage.getItem(TOKEN_KEY);
      const 本地房间 = localStorage.getItem(ROOM_KEY);
      if (!本地Token || !本地房间) {
        return;
      }
      socket.emit("state:resync", { roomId: 本地房间, token: 本地Token }, (result) => {
        try {
          const data = unwrapAck(result);
          set作用域状态(data);
          set我的玩家ID(data.privateState.selfPlayerId);
        } catch (err) {
          set错误列表((prev) => [`重连失败：${String(err)}`, ...prev].slice(0, 20));
        }
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const 公开状态 =作用域状态?.publicState;
  const 私有状态 =作用域状态?.privateState;
  const 当前玩家ID =公开状态?.currentPlayerId;
  const 是否我的回合 = 当前玩家ID === 我的玩家ID;
  const 我 =公开状态?.players.find((p) => p.id === 我的玩家ID);
  const 当前行动者 =公开状态?.players.find((p) => p.id === 当前玩家ID);

  function 追加错误(message: string): void {
    set错误列表((prev) => [message, ...prev].slice(0, 20));
  }

  function 创建房间(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (!玩家名.trim()) {
      追加错误("请输入昵称。");
      return;
    }

    socket.emit("room:create", { playerName: 玩家名.trim(), token: token || undefined }, (result) => {
      try {
        const data = unwrapAck(result);
        setToken(data.token);
        set我的玩家ID(data.playerId);
        set房间号输入(data.roomId);
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(ROOM_KEY, data.roomId);
        localStorage.setItem(NAME_KEY, 玩家名.trim());
      } catch (err) {
        追加错误(String(err));
      }
    });
  }

  function 加入房间(): void {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    if (!玩家名.trim()) {
      追加错误("请输入昵称。");
      return;
    }
    if (!房间号输入.trim()) {
      追加错误("请输入房间号。");
      return;
    }

    socket.emit(
      "room:join",
      {
        roomId: 房间号输入.trim().toUpperCase(),
        playerName: 玩家名.trim(),
        token: token || undefined,
      },
      (result) => {
        try {
          const data = unwrapAck(result);
          setToken(data.token);
          set我的玩家ID(data.playerId);
          localStorage.setItem(TOKEN_KEY, data.token);
          localStorage.setItem(ROOM_KEY, data.roomId);
          localStorage.setItem(NAME_KEY, 玩家名.trim());
        } catch (err) {
          追加错误(String(err));
        }
      },
    );
  }

  function 准备切换(): void {
    const socket = socketRef.current;
    if (!socket || !公开状态 || !我) {
      return;
    }
    socket.emit("room:ready", { roomId: 公开状态.roomId, ready: !我.ready }, (result) => {
      if (!result.ok) {
        追加错误(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function 开始游戏(): void {
    const socket = socketRef.current;
    if (!socket || !公开状态) {
      return;
    }
    socket.emit("game:start", { roomId: 公开状态.roomId }, (result) => {
      if (!result.ok) {
        追加错误(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function 执行偷看(): void {
    const socket = socketRef.current;
    if (!socket || !公开状态 || !选中目标) {
      return;
    }
    socket.emit("action:peek", { roomId: 公开状态.roomId, targetPlayerId: 选中目标 }, (result) => {
      if (!result.ok) {
        追加错误(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function 执行交换(): void {
    const socket = socketRef.current;
    if (!socket || !公开状态 || !选中目标) {
      return;
    }
    socket.emit("action:swap", { roomId: 公开状态.roomId, targetPlayerId: 选中目标 }, (result) => {
      if (!result.ok) {
        追加错误(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function 执行换中间牌(): void {
    const socket = socketRef.current;
    if (!socket || !公开状态) {
      return;
    }
    socket.emit("action:swapCenter", { roomId: 公开状态.roomId }, (result) => {
      if (!result.ok) {
        追加错误(`${result.error.code}: ${result.error.message}`);
      }
    });
  }

  function 执行公开(): void {
    const socket = socketRef.current;
    if (!socket || !公开状态) {
      return;
    }
    const followerIds = 跟随者输入
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    socket.emit(
      "action:reveal",
      {
        roomId: 公开状态.roomId,
        targetPlayerId: 选中目标 || undefined,
        oraclePrediction: 占卜阵营,
        followerIds: followerIds.length > 0 ? followerIds : undefined,
        triggerGlobalSwap: 触发全场交换,
      },
      (result) => {
        if (!result.ok) {
          追加错误(`${result.error.code}: ${result.error.message}`);
        }
      },
    );
  }

  function 离开房间(): void {
    const socket = socketRef.current;
    if (!socket || !公开状态) {
      return;
    }
    socket.emit("room:leave", { roomId: 公开状态.roomId }, () => {
      set作用域状态(null);
      set我的玩家ID("");
      set选中目标("");
      set跟随者输入("");
      localStorage.removeItem(ROOM_KEY);
    });
  }

  if (!公开状态) {
    return (
      <div className="shell">
        <div className="hero">
          <p className="hero-badge">多人实时策略 · 身份隐藏 · 阵营摇摆</p>
          <h1>杀死苏丹 Online</h1>
          <p>输入昵称后即可创建房间，邀请朋友输入房间号开玩。</p>
        </div>
        <div className="card lobby-card">
          <label>你的昵称</label>
          <input value={玩家名} onChange={(e) => set玩家名(e.target.value)} placeholder="例如：夜行刺客" />
          <label>房间号（加入时填写）</label>
          <input
            value={房间号输入}
            onChange={(e) => set房间号输入(e.target.value.toUpperCase())}
            placeholder="例如：AB12CD"
          />
          <div className="row">
            <button onClick={创建房间}>创建房间</button>
            <button className="btn-secondary" onClick={加入房间}>
              加入房间
            </button>
          </div>
          <p className="tip">提示：同一台电脑可开多个无痕窗口，快速模拟多人测试。</p>
        </div>
        <错误面板 errors={错误列表} />
      </div>
    );
  }

  const 行动禁用 = 公开状态.phase !== "in_game" || !是否我的回合;
  const 我身份 = 私有状态?.selfRole;
  const 我身份信息 = 我身份 ? ROLE_META[我身份] : undefined;

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>房间 {公开状态.roomId}</h1>
          <p className="topbar-sub">
            阶段：
            {公开状态.phase === "lobby" ? "准备阶段" : 公开状态.phase === "in_game" ? "游戏中" : "已结束"}
          </p>
        </div>
        <div className="topbar-meta">
          <span>你是：{我?.name}</span>
          <button className="btn-secondary" onClick={离开房间}>
            退出房间
          </button>
        </div>
      </header>

      <section className="grid">
        <article className="panel panel-role">
          <h2>我的身份</h2>
          {我身份 && 我身份信息 ? (
            <div className="my-role-card">
              <RoleAvatar role={我身份} label={我身份信息.缩写} size="xl" />
              <div>
                <p className="role-name">{我身份信息.中文名}</p>
                <p className="role-faction">
                  {角色阵营中文(我身份, Boolean(私有状态?.selfCardFaceUp))}
                  {私有状态?.selfCardFaceUp ? " · 已公开" : " · 暗置"}
                </p>
              </div>
            </div>
          ) : (
            <p>尚未分配身份。</p>
          )}

          {公开状态.phase === "in_game" ? (
            <div className="turn-box">
              <p>第 {公开状态.turn.round} 轮</p>
              <p>
                当前行动：<strong>{当前行动者?.name ?? "-"}</strong>
              </p>
              <p>{是否我的回合 ? "现在轮到你行动。" : "请等待其他玩家行动。"}</p>
            </div>
          ) : null}

          {公开状态.winner ? (
            <p className="winner">
              胜利阵营：{阵营中文(公开状态.winner.winnerFaction)} | {公开状态.winner.reason}
            </p>
          ) : null}
        </article>

        <article className="panel">
          <h2>玩家席位</h2>
          <div className="players-grid">
            {公开状态.players.map((player) => {
              const isCurrent = player.id === 当前玩家ID;
              const isSelected = player.id === 选中目标;
              const revealedRole = player.revealedRole;
              return (
                <button
                  key={player.id}
                  className={`player-card ${isCurrent ? "current" : ""} ${isSelected ? "selected" : ""}`}
                  onClick={() => set选中目标(player.id)}
                >
                  <div className="player-head">
                    <strong>{player.name}</strong>
                    <span>{player.id === 我的玩家ID ? "我" : `座位${player.seatIndex + 1}`}</span>
                  </div>
                  <div className="player-role">
                    {revealedRole ? (
                      <>
                        <RoleAvatar role={revealedRole} label={ROLE_META[revealedRole].缩写} size="sm" />
                        <span>{ROLE_META[revealedRole].中文名}</span>
                      </>
                    ) : (
                      <span>暗置身份</span>
                    )}
                  </div>
                  <div className="badge-row">
                    <span className={`badge ${player.alive ? "ok" : "warn"}`}>{player.alive ? "存活" : "死亡"}</span>
                    <span className={`badge ${player.connected ? "ok" : "warn"}`}>
                      {player.connected ? "在线" : "离线"}
                    </span>
                    <span className={`badge ${player.skipActions > 0 ? "warn" : "ok"}`}>
                      {player.skipActions > 0 ? "被拘留" : "可行动"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {公开状态.phase === "lobby" ? (
            <div className="row">
              <button onClick={准备切换}>{我?.ready ? "取消准备" : "准备"}</button>
              {公开状态.hostPlayerId === 我的玩家ID ? (
                <button className="btn-secondary" onClick={开始游戏}>
                  开始游戏
                </button>
              ) : null}
            </div>
          ) : null}
        </article>

        <article className="panel">
          <h2>行动面板</h2>
          <p className="tip">当前目标：{选中目标 || "未选择"}</p>
          <div className="row">
            <button disabled={行动禁用 || !选中目标} onClick={执行偷看}>
              偷看
            </button>
            <button disabled={行动禁用 || !选中目标} onClick={执行交换}>
              交换
            </button>
            <button disabled={行动禁用} onClick={执行换中间牌}>
              换中间牌
            </button>
          </div>
          <label>占卜阵营（占卜师公开时使用）</label>
          <select
            value={占卜阵营}
            onChange={(e) => set占卜阵营(e.target.value as WinFaction)}
            disabled={行动禁用}
          >
            <option value="rebels">革命党</option>
            <option value="loyalists">保皇派</option>
          </select>
          <label>奴隶跟随者 ID（多个用英文逗号分隔）</label>
          <input
            value={跟随者输入}
            onChange={(e) => set跟随者输入(e.target.value)}
            placeholder="例如：a1b2,c3d4"
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={触发全场交换}
              onChange={(e) => set触发全场交换(e.target.checked)}
              disabled={行动禁用}
            />
            肚皮舞娘扩展：触发全场暗牌交换（需服务端开启扩展）
          </label>
          <button disabled={行动禁用} onClick={执行公开}>
            公开身份并触发技能
          </button>
        </article>

        <article className="panel">
          <h2>私密情报</h2>
          <p>当前身份：{我身份 ? ROLE_META[我身份].中文名 : "-"}</p>
          <p>牌面状态：{私有状态?.selfCardFaceUp ? "已公开" : "暗置"}</p>
          <p>占卜选择：{私有状态?.oraclePrediction ? 阵营中文(私有状态.oraclePrediction) : "-"}</p>
          <ul className="text-list">
            {私有状态?.privateKnowledge.map((note, idx) => (
              <li key={`${note.subjectType}-${note.subjectId}-${idx}`}>
                {情报来源中文(note.source)}看到
                {note.subjectType === "center" ? "中间牌" : `玩家 ${note.subjectId}`}为
                {ROLE_META[note.role].中文名}
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>行动日志</h2>
          <ul className="text-list">
            {公开状态.logs.map((log) => (
              <li key={log.id}>{log.message}</li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>私密提示</h2>
          <ul className="text-list">
            {私密动态.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </article>
      </section>

      <错误面板 errors={错误列表} />
    </div>
  );
}

function RoleAvatar(props: { role: Role; label: string; size: "sm" | "xl" }) {
  const [加载失败, set加载失败] = useState(false);
  const meta = ROLE_META[props.role];
  return (
    <div className={`role-avatar ${props.size === "xl" ? "xl" : "sm"}`}>
      {!加载失败 ? (
        <img src={meta.图标} alt={meta.中文名} onError={() => set加载失败(true)} />
      ) : (
        <span>{props.label}</span>
      )}
    </div>
  );
}

function 错误面板(props: { errors: string[] }) {
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
