import { useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { PlayerScopedState, PublicGameView, Role, WinFaction } from "@sultan/shared";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000";

type ClientSocket = Socket<any, any>;

type AckResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

interface PlayerDraft {
  targetPlayerId: string;
  oraclePrediction: WinFaction;
  forceSkillTargetId: string;
  forceOraclePrediction: WinFaction;
  followerIds: string[];
  slaveTraderTargets: string[];
  forceFollowerIds: string[];
  forceSlaveTraderTargets: string[];
  rawEvent: string;
  rawPayloadJson: string;
}

interface SimPlayer {
  index: number;
  name: string;
  roomId?: string;
  token?: string;
  playerId?: string;
  connected: boolean;
  scopedState?: PlayerScopedState;
  draft: PlayerDraft;
  logs: string[];
  lastAction?: string;
}

type ListDraftKey =
  | "followerIds"
  | "slaveTraderTargets"
  | "forceFollowerIds"
  | "forceSlaveTraderTargets";

const ROLE_NAME: Record<Role, string> = {
  sultan: "苏丹",
  assassin: "刺客",
  guard: "守卫",
  slave: "奴隶",
  oracle: "占卜师",
  belly_dancer: "肚皮舞娘",
  slave_trader: "奴隶贩子",
  grand_official: "大官",
};

function roleActionLabel(role?: Role): string {
  switch (role) {
    case "sultan":
      return "公开身份（可选择处决目标）";
    case "assassin":
      return "刺杀目标";
    case "guard":
      return "拘留目标";
    case "slave":
      return "发动起义";
    case "oracle":
      return "公开并占卜";
    case "belly_dancer":
      return "公开身份";
    case "slave_trader":
      return "发动奴隶筛查";
    case "grand_official":
      return "强制目标执行技能";
    default:
      return "公开身份并触发技能";
  }
}

function roleActionHint(role?: Role): string {
  switch (role) {
    case "sultan":
      return "你可以不选目标直接公开；若要处决，目标必须是已公开革命角色。";
    case "assassin":
      return "请先选目标，再点击“刺杀目标”。";
    case "guard":
      return "请先选目标，再点击“拘留目标”。";
    case "slave":
      return "可勾选跟随起义的奴隶（可选）。";
    case "oracle":
      return "选择预测阵营后执行即可。";
    case "belly_dancer":
      return "直接公开即可生效魅惑。";
    case "slave_trader":
      return "先把目标加入链式列表，再执行技能。";
    case "grand_official":
      return "请先选被强制玩家，可按需配置强制技能参数。";
    default:
      return "公开后会自动按角色规则结算。";
  }
}

function roleNeedsTarget(role?: Role): boolean {
  return role === "assassin" || role === "guard" || role === "grand_official";
}

function createDefaultPlayer(index: number): SimPlayer {
  return {
    index,
    name: `测试玩家${index + 1}`,
    connected: false,
    draft: {
      targetPlayerId: "",
      oraclePrediction: "rebels",
      forceSkillTargetId: "",
      forceOraclePrediction: "rebels",
      followerIds: [],
      slaveTraderTargets: [],
      forceFollowerIds: [],
      forceSlaveTraderTargets: [],
      rawEvent: "action:reveal",
      rawPayloadJson: "{}",
    },
    logs: [],
  };
}

function safeJsonParse(input: string): { ok: true; value: any } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "JSON 解析失败",
    };
  }
}

function extractAckMessage(result: AckResult<any>): string {
  if (result.ok) {
    return "ACK: ok";
  }
  return `ACK: ${result.error.code} - ${result.error.message}`;
}

function joinNameByIds(players: PublicGameView["players"], ids: string[]): string {
  if (ids.length === 0) {
    return "未设置";
  }
  return ids
    .map((id) => {
      const found = players.find((player) => player.id === id);
      return found ? found.name : id;
    })
    .join(" -> ");
}

export function TestLab() {
  const socketsRef = useRef<Map<number, ClientSocket>>(new Map());
  const [simCount, setSimCount] = useState(5);
  const [players, setPlayers] = useState<SimPlayer[]>(() => {
    return Array.from({ length: 5 }, (_, i) => createDefaultPlayer(i));
  });
  const [roomId, setRoomId] = useState("");
  const [globalLogs, setGlobalLogs] = useState<string[]>([]);
  const [lastUiPulseKey, setLastUiPulseKey] = useState("");

  const publicState = useMemo(() => {
    for (const player of players) {
      if (player.scopedState?.publicState) {
        return player.scopedState.publicState;
      }
    }
    return undefined;
  }, [players]);

  function pulseUi(key: string): void {
    setLastUiPulseKey(key);
    setTimeout(() => {
      setLastUiPulseKey((prev) => (prev === key ? "" : prev));
    }, 360);
  }

  function pushGlobalLog(message: string): void {
    setGlobalLogs((prev) => [`${new Date().toLocaleTimeString()} | ${message}`, ...prev].slice(0, 200));
  }

  function updatePlayer(index: number, updater: (prev: SimPlayer) => SimPlayer): void {
    setPlayers((prev) => prev.map((player) => (player.index === index ? updater(player) : player)));
  }

  function appendPlayerLog(index: number, message: string): void {
    updatePlayer(index, (player) => ({
      ...player,
      logs: [`${new Date().toLocaleTimeString()} | ${message}`, ...player.logs].slice(0, 80),
    }));
  }

  function markLastAction(index: number, actionName: string): void {
    updatePlayer(index, (player) => ({ ...player, lastAction: actionName }));
  }

  function setDraftField(index: number, key: keyof PlayerDraft, value: string | string[]): void {
    updatePlayer(index, (player) => ({
      ...player,
      draft: {
        ...player.draft,
        [key]: value,
      },
    }));
  }

  function toggleDraftListItem(index: number, key: ListDraftKey, value: string): void {
    updatePlayer(index, (player) => {
      const list = player.draft[key];
      const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
      return {
        ...player,
        draft: {
          ...player.draft,
          [key]: next,
        },
      };
    });
  }

  function appendCurrentTargetToList(index: number, key: ListDraftKey): void {
    const player = players[index];
    const targetId = player?.draft.targetPlayerId;
    if (!targetId) {
      appendPlayerLog(index, "请先选择目标玩家。");
      return;
    }
    updatePlayer(index, (prev) => {
      const oldList = prev.draft[key];
      if (oldList.includes(targetId)) {
        return prev;
      }
      return {
        ...prev,
        draft: {
          ...prev.draft,
          [key]: [...oldList, targetId],
        },
      };
    });
  }

  function clearDraftList(index: number, key: ListDraftKey): void {
    updatePlayer(index, (player) => ({
      ...player,
      draft: {
        ...player.draft,
        [key]: [],
      },
    }));
  }

  function ensureSocket(index: number): ClientSocket {
    const existed = socketsRef.current.get(index);
    if (existed) {
      return existed;
    }
    const socket: ClientSocket = io(SERVER_URL, { transports: ["websocket"] });
    socketsRef.current.set(index, socket);

    socket.on("connect", () => {
      updatePlayer(index, (player) => ({ ...player, connected: true }));
      appendPlayerLog(index, "socket 已连接");
    });

    socket.on("disconnect", () => {
      updatePlayer(index, (player) => ({ ...player, connected: false }));
      appendPlayerLog(index, "socket 已断开");
    });

    socket.on("room:update", (state: PublicGameView) => {
      updatePlayer(index, (player) =>
        player.scopedState
          ? { ...player, scopedState: { ...player.scopedState, publicState: state } }
          : player,
      );
    });

    socket.on("game:state", (state: PlayerScopedState) => {
      updatePlayer(index, (player) => ({
        ...player,
        scopedState: state,
        roomId: state.publicState.roomId,
        playerId: state.privateState.selfPlayerId,
      }));
    });

    socket.on("game:error", (payload: { code: string; message: string }) => {
      appendPlayerLog(index, `game:error ${payload.code} - ${payload.message}`);
    });

    socket.on("game:private", (payload: { message: string }) => {
      appendPlayerLog(index, `私密提示: ${payload.message}`);
    });

    socket.on("game:over", () => {
      appendPlayerLog(index, "收到 game:over");
    });

    return socket;
  }

  function disconnectAllSockets(): void {
    for (const socket of socketsRef.current.values()) {
      socket.disconnect();
    }
    socketsRef.current.clear();
  }

  function resetPlayers(nextCount: number): void {
    disconnectAllSockets();
    setRoomId("");
    setGlobalLogs([]);
    setPlayers(Array.from({ length: nextCount }, (_, i) => createDefaultPlayer(i)));
  }

  async function emitAck<T = unknown>(index: number, eventName: string, payload: any): Promise<AckResult<T>> {
    const socket = ensureSocket(index);
    return await new Promise((resolve) => {
      (socket as any).emit(eventName, payload, (result: AckResult<T>) => resolve(result));
    });
  }

  async function createRoomAndJoinAll(): Promise<void> {
    pulseUi("global-create");
    if (players.length < 5 || players.length > 15) {
      pushGlobalLog("玩家数量必须在 5-15 之间。");
      return;
    }

    for (const player of players) {
      ensureSocket(player.index);
    }

    const host = players[0];
    const createResult = await emitAck<{ roomId: string; playerId: string; token: string }>(
      host.index,
      "room:create",
      {
        playerName: host.name,
      },
    );
    appendPlayerLog(host.index, extractAckMessage(createResult));
    if (!createResult.ok) {
      return;
    }

    const newRoomId = createResult.data.roomId;
    setRoomId(newRoomId);
    updatePlayer(host.index, (prev) => ({
      ...prev,
      roomId: newRoomId,
      playerId: createResult.data.playerId,
      token: createResult.data.token,
    }));
    pushGlobalLog(`房间已创建：${newRoomId}`);

    for (let i = 1; i < players.length; i += 1) {
      const player = players[i];
      const joinResult = await emitAck<{ roomId: string; playerId: string; token: string }>(player.index, "room:join", {
        roomId: newRoomId,
        playerName: player.name,
      });
      appendPlayerLog(player.index, extractAckMessage(joinResult));
      if (joinResult.ok) {
        updatePlayer(player.index, (prev) => ({
          ...prev,
          roomId: joinResult.data.roomId,
          playerId: joinResult.data.playerId,
          token: joinResult.data.token,
        }));
      }
    }
  }

  async function readyAll(): Promise<void> {
    pulseUi("global-ready");
    if (!roomId) {
      pushGlobalLog("请先创建并加入房间。");
      return;
    }
    for (const player of players) {
      const result = await emitAck(player.index, "room:ready", { roomId, ready: true });
      appendPlayerLog(player.index, extractAckMessage(result));
    }
  }

  async function startByHost(): Promise<void> {
    pulseUi("global-start");
    if (!roomId) {
      pushGlobalLog("请先创建并加入房间。");
      return;
    }
    const result = await emitAck(players[0].index, "game:start", { roomId });
    appendPlayerLog(players[0].index, extractAckMessage(result));
  }

  async function sendAction(index: number, action: "peek" | "swap" | "swapCenter"): Promise<void> {
    pulseUi(`basic-${index}-${action}`);
    const player = players[index];
    if (!player.roomId) {
      appendPlayerLog(index, "未在房间中。");
      return;
    }

    let payload: any = { roomId: player.roomId };
    let eventName = "";
    let actionLabel = "";

    if (action === "peek") {
      eventName = "action:peek";
      actionLabel = "偷看";
      payload.targetPlayerId = player.draft.targetPlayerId;
    } else if (action === "swap") {
      eventName = "action:swap";
      actionLabel = "交换";
      payload.targetPlayerId = player.draft.targetPlayerId;
    } else {
      eventName = "action:swapCenter";
      actionLabel = "换中间牌";
    }

    const result = await emitAck(index, eventName, payload);
    appendPlayerLog(index, extractAckMessage(result));
    if (result.ok) {
      markLastAction(index, actionLabel);
    }
  }

  async function sendRoleSkill(index: number): Promise<void> {
    pulseUi(`role-${index}`);
    const player = players[index];
    const role = player.scopedState?.privateState.selfRole;

    if (!player.roomId) {
      appendPlayerLog(index, "未在房间中。");
      return;
    }
    if (!role) {
      appendPlayerLog(index, "尚未分配角色，无法执行角色技能。");
      return;
    }

    if (roleNeedsTarget(role) && !player.draft.targetPlayerId) {
      appendPlayerLog(index, "请先选择目标玩家。");
      return;
    }
    if (role === "slave_trader" && player.draft.slaveTraderTargets.length === 0) {
      appendPlayerLog(index, "奴隶贩子请先加入至少一个链式目标。");
      return;
    }

    const payload: any = {
      roomId: player.roomId,
      targetPlayerId: player.draft.targetPlayerId || undefined,
      followerIds: player.draft.followerIds.length > 0 ? player.draft.followerIds : undefined,
      slaveTraderTargets: player.draft.slaveTraderTargets.length > 0 ? player.draft.slaveTraderTargets : undefined,
    };

    if (role === "oracle") {
      payload.oraclePrediction = player.draft.oraclePrediction;
    }

    if (role === "grand_official") {
      payload.oraclePrediction = player.draft.oraclePrediction;
      const forceSkill: any = {
        targetPlayerId: player.draft.forceSkillTargetId || undefined,
        followerIds: player.draft.forceFollowerIds.length > 0 ? player.draft.forceFollowerIds : undefined,
        slaveTraderTargets:
          player.draft.forceSlaveTraderTargets.length > 0 ? player.draft.forceSlaveTraderTargets : undefined,
        oraclePrediction: player.draft.forceOraclePrediction,
      };
      payload.forceSkill = forceSkill;
    }

    const result = await emitAck(index, "action:reveal", payload);
    appendPlayerLog(index, extractAckMessage(result));
    if (result.ok) {
      markLastAction(index, roleActionLabel(role));
    }
  }

  async function sendRaw(index: number): Promise<void> {
    pulseUi(`raw-${index}`);
    const player = players[index];
    const eventName = player.draft.rawEvent.trim();
    if (!eventName) {
      appendPlayerLog(index, "请输入事件名。");
      return;
    }
    const parsed = safeJsonParse(player.draft.rawPayloadJson);
    if (!parsed.ok) {
      appendPlayerLog(index, `JSON 错误: ${parsed.message}`);
      return;
    }
    const result = await emitAck(index, eventName, parsed.value);
    appendPlayerLog(index, extractAckMessage(result));
  }

  async function reconnect(index: number): Promise<void> {
    pulseUi(`reconnect-${index}`);
    const player = players[index];
    if (!player.roomId || !player.token) {
      appendPlayerLog(index, "缺少 roomId/token，无法重连。");
      return;
    }
    const socket = ensureSocket(index);
    if (!socket.connected) {
      socket.connect();
    }
    const result = await emitAck(index, "state:resync", {
      roomId: player.roomId,
      token: player.token,
    });
    appendPlayerLog(index, extractAckMessage(result));
  }

  function disconnect(index: number): void {
    pulseUi(`disconnect-${index}`);
    const socket = socketsRef.current.get(index);
    if (socket) {
      socket.disconnect();
    }
  }

  async function leave(index: number): Promise<void> {
    pulseUi(`leave-${index}`);
    const player = players[index];
    if (!player.roomId) {
      return;
    }
    const result = await emitAck(index, "room:leave", { roomId: player.roomId });
    appendPlayerLog(index, extractAckMessage(result));
  }

  return (
    <div className="lab-shell">
      <h1>刺杀苏丹王 KillSultan 测试大厅</h1>
      <p className="lab-subtitle">
        这是给普通玩家也能用的测试页：先选目标，再点按钮即可。高级 JSON 调试在折叠区里。
      </p>
      <p className="lab-status">
        当前模拟人数：{players.length}（支持 5-15） | 房间：{roomId || "-"} | 当前轮次：
        {publicState?.turn.round ?? "-"} | 当前行动者：{publicState?.currentPlayerId ?? "-"}
      </p>

      <div className="lab-toolbar">
        <input
          type="number"
          min={5}
          max={15}
          value={simCount}
          onChange={(event) => setSimCount(Number(event.target.value))}
          className="lab-number"
        />
        <button className={`lab-btn ${lastUiPulseKey === "global-reset" ? "is-pulse" : ""}`} onClick={() => {
          pulseUi("global-reset");
          resetPlayers(Math.max(5, Math.min(15, simCount)));
        }}>
          重置模拟玩家
        </button>
        <button className={`lab-btn ${lastUiPulseKey === "global-create" ? "is-pulse" : ""}`} onClick={createRoomAndJoinAll}>
          一键建房并全部加入
        </button>
        <button className={`lab-btn ${lastUiPulseKey === "global-ready" ? "is-pulse" : ""}`} onClick={readyAll}>
          全部准备
        </button>
        <button className={`lab-btn ${lastUiPulseKey === "global-start" ? "is-pulse" : ""}`} onClick={startByHost}>
          房主开始游戏
        </button>
        <button
          className={`lab-btn lab-btn-ghost ${lastUiPulseKey === "global-disconnect" ? "is-pulse" : ""}`}
          onClick={() => {
            pulseUi("global-disconnect");
            disconnectAllSockets();
          }}
        >
          断开全部连接
        </button>
      </div>

      <details className="lab-details">
        <summary>全局日志</summary>
        <div className="lab-logbox">
          {globalLogs.map((line, i) => (
            <div key={`${line}-${i}`}>{line}</div>
          ))}
        </div>
      </details>

      <div className="lab-grid">
        {players.map((player) => {
          const myRole = player.scopedState?.privateState.selfRole;
          const isTurn = publicState?.currentPlayerId && publicState.currentPlayerId === player.playerId;
          const playerOptions = publicState?.players ?? [];
          const selectablePlayers = playerOptions.filter((p) => p.id !== player.playerId);

          return (
            <section key={player.index} className={`lab-card ${isTurn ? "is-turn" : ""}`}>
              <div className="lab-card-head">
                <h3>
                  P{player.index + 1} - {player.name} {isTurn ? "（当前回合）" : ""}
                </h3>
                <span className={`lab-badge ${player.connected ? "ok" : "warn"}`}>
                  {player.connected ? "在线" : "离线"}
                </span>
              </div>
              <div className="lab-meta">playerId：{player.playerId ?? "-"}</div>
              <div className="lab-meta">角色：{myRole ? `${ROLE_NAME[myRole]}（${myRole}）` : "-"}</div>
              <div className="lab-meta">最近操作：{player.lastAction ?? "-"}</div>

              <div className="lab-section">
                <label>目标玩家</label>
                <select
                  value={player.draft.targetPlayerId}
                  onChange={(event) => setDraftField(player.index, "targetPlayerId", event.target.value)}
                >
                  <option value="">-- 选择目标 --</option>
                  {selectablePlayers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} | 座位{p.seatIndex + 1}
                    </option>
                  ))}
                </select>
                <div className="lab-chip-row">
                  {selectablePlayers.map((p) => {
                    const selected = player.draft.targetPlayerId === p.id;
                    return (
                      <button
                        key={p.id}
                        className={`lab-chip ${selected ? "selected" : ""}`}
                        onClick={() => setDraftField(player.index, "targetPlayerId", p.id)}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="lab-section">
                <div className="lab-row">
                  <button
                    className={`lab-btn ${lastUiPulseKey === `basic-${player.index}-peek` ? "is-pulse" : ""}`}
                    onClick={() => sendAction(player.index, "peek")}
                  >
                    偷看
                  </button>
                  <button
                    className={`lab-btn ${lastUiPulseKey === `basic-${player.index}-swap` ? "is-pulse" : ""}`}
                    onClick={() => sendAction(player.index, "swap")}
                  >
                    交换
                  </button>
                  <button
                    className={`lab-btn ${lastUiPulseKey === `basic-${player.index}-swapCenter` ? "is-pulse" : ""}`}
                    onClick={() => sendAction(player.index, "swapCenter")}
                  >
                    换中间牌
                  </button>
                </div>
              </div>

              <div className="lab-section lab-role-skill">
                <strong>{roleActionLabel(myRole)}</strong>
                <p>{roleActionHint(myRole)}</p>

                {myRole === "oracle" || myRole === "grand_official" ? (
                  <>
                    <label>预测阵营</label>
                    <select
                      value={player.draft.oraclePrediction}
                      onChange={(event) =>
                        setDraftField(player.index, "oraclePrediction", event.target.value as WinFaction)
                      }
                    >
                      <option value="rebels">革命党</option>
                      <option value="loyalists">保皇派</option>
                    </select>
                  </>
                ) : null}

                {myRole === "slave" ? (
                  <>
                    <label>跟随起义玩家（可多选）</label>
                    <div className="lab-chip-row">
                      {selectablePlayers.map((p) => {
                        const checked = player.draft.followerIds.includes(p.id);
                        return (
                          <button
                            key={`follower-${p.id}`}
                            className={`lab-chip ${checked ? "selected" : ""}`}
                            onClick={() => toggleDraftListItem(player.index, "followerIds", p.id)}
                          >
                            {checked ? "已选" : "选择"} {p.name}
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}

                {myRole === "slave_trader" ? (
                  <>
                    <label>链式目标顺序</label>
                    <div className="lab-row">
                      <button className="lab-btn" onClick={() => appendCurrentTargetToList(player.index, "slaveTraderTargets")}>
                        把当前目标加入链式列表
                      </button>
                      <button className="lab-btn lab-btn-ghost" onClick={() => clearDraftList(player.index, "slaveTraderTargets")}>
                        清空链式列表
                      </button>
                    </div>
                    <p className="lab-inline-note">
                      当前顺序：{joinNameByIds(playerOptions, player.draft.slaveTraderTargets)}
                    </p>
                  </>
                ) : null}

                {myRole === "grand_official" ? (
                  <>
                    <label>强制技能二级目标（可选）</label>
                    <select
                      value={player.draft.forceSkillTargetId}
                      onChange={(event) => setDraftField(player.index, "forceSkillTargetId", event.target.value)}
                    >
                      <option value="">-- 不设置 --</option>
                      {selectablePlayers.map((p) => (
                        <option key={`force-target-${p.id}`} value={p.id}>
                          {p.name} | 座位{p.seatIndex + 1}
                        </option>
                      ))}
                    </select>

                    <label>强制占卜阵营（仅对占卜师目标有效）</label>
                    <select
                      value={player.draft.forceOraclePrediction}
                      onChange={(event) =>
                        setDraftField(player.index, "forceOraclePrediction", event.target.value as WinFaction)
                      }
                    >
                      <option value="rebels">革命党</option>
                      <option value="loyalists">保皇派</option>
                    </select>

                    <label>强制-奴隶跟随玩家（可多选）</label>
                    <div className="lab-chip-row">
                      {selectablePlayers.map((p) => {
                        const checked = player.draft.forceFollowerIds.includes(p.id);
                        return (
                          <button
                            key={`force-follower-${p.id}`}
                            className={`lab-chip ${checked ? "selected" : ""}`}
                            onClick={() => toggleDraftListItem(player.index, "forceFollowerIds", p.id)}
                          >
                            {checked ? "已选" : "选择"} {p.name}
                          </button>
                        );
                      })}
                    </div>

                    <label>强制-奴隶贩子链式目标</label>
                    <div className="lab-row">
                      <button
                        className="lab-btn"
                        onClick={() => appendCurrentTargetToList(player.index, "forceSlaveTraderTargets")}
                      >
                        把当前目标加入强制链式列表
                      </button>
                      <button
                        className="lab-btn lab-btn-ghost"
                        onClick={() => clearDraftList(player.index, "forceSlaveTraderTargets")}
                      >
                        清空强制链式列表
                      </button>
                    </div>
                    <p className="lab-inline-note">
                      当前顺序：{joinNameByIds(playerOptions, player.draft.forceSlaveTraderTargets)}
                    </p>
                  </>
                ) : null}

                <button
                  className={`lab-btn lab-btn-primary ${lastUiPulseKey === `role-${player.index}` ? "is-pulse" : ""}`}
                  onClick={() => sendRoleSkill(player.index)}
                >
                  {roleActionLabel(myRole)}
                </button>

                {roleNeedsTarget(myRole) ? <p className="lab-inline-note">提示：该技能需要先选目标。</p> : null}
              </div>

              <details className="lab-details">
                <summary>高级调试（可选）</summary>
                <p className="lab-inline-note">
                  普通测试不需要填写这一块。只有你要模拟特殊协议场景时，才用自定义事件。
                </p>
                <p className="lab-inline-note">
                  示例：事件名填 <code>room:ready</code>，JSON 填{" "}
                  <code>{`{"roomId":"房间号","ready":true}`}</code>。
                </p>
                <label>自定义事件名</label>
                <input
                  value={player.draft.rawEvent}
                  onChange={(event) => setDraftField(player.index, "rawEvent", event.target.value)}
                />
                <label>自定义事件 JSON</label>
                <textarea
                  rows={4}
                  value={player.draft.rawPayloadJson}
                  onChange={(event) => setDraftField(player.index, "rawPayloadJson", event.target.value)}
                />
                <button
                  className={`lab-btn ${lastUiPulseKey === `raw-${player.index}` ? "is-pulse" : ""}`}
                  onClick={() => sendRaw(player.index)}
                >
                  发送自定义事件
                </button>
              </details>

              <div className="lab-row">
                <button
                  className={`lab-btn ${lastUiPulseKey === `reconnect-${player.index}` ? "is-pulse" : ""}`}
                  onClick={() => reconnect(player.index)}
                >
                  重连
                </button>
                <button
                  className={`lab-btn lab-btn-ghost ${lastUiPulseKey === `disconnect-${player.index}` ? "is-pulse" : ""}`}
                  onClick={() => disconnect(player.index)}
                >
                  断开
                </button>
                <button
                  className={`lab-btn lab-btn-ghost ${lastUiPulseKey === `leave-${player.index}` ? "is-pulse" : ""}`}
                  onClick={() => leave(player.index)}
                >
                  离开房间
                </button>
              </div>

              <details className="lab-details">
                <summary>玩家日志（最近 80 条）</summary>
                <div className="lab-logbox">
                  {player.logs.map((line, i) => (
                    <div key={`${line}-${i}`}>{line}</div>
                  ))}
                </div>
              </details>
            </section>
          );
        })}
      </div>
    </div>
  );
}
