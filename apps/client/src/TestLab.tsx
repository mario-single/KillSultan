import { useEffect, useMemo, useState } from "react";

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 15;
const HOST_SLOT = "lab_host";

const STORAGE_KEYS = ["sultan_token", "sultan_room_id", "sultan_name"] as const;

function slotKey(base: (typeof STORAGE_KEYS)[number], slot: string): string {
  return `${base}_${slot}`;
}

function buildSimUrl(params: {
  slot: string;
  name: string;
  mode: "create" | "join";
  roomId?: string;
  autoReady: boolean;
  autoStart: boolean;
  bootId: number;
}): string {
  const query = new URLSearchParams();
  query.set("simSlot", params.slot);
  query.set("simName", params.name);
  query.set("simAuto", params.mode);
  if (params.mode === "join" && params.roomId) {
    query.set("simRoom", params.roomId);
  }
  if (params.autoReady) {
    query.set("simAutoReady", "1");
  }
  if (params.autoStart) {
    query.set("simAutoStart", "1");
  }
  query.set("simCompact", "1");
  query.set("embed", "1");
  query.set("v", String(params.bootId));
  return `/?${query.toString()}`;
}

function clampPlayerCount(value: number): number {
  if (Number.isNaN(value)) {
    return MIN_PLAYERS;
  }
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.floor(value)));
}

export function TestLab() {
  const [simCount, setSimCount] = useState<number>(5);
  const [running, setRunning] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [bootId, setBootId] = useState(1);
  const [autoReady, setAutoReady] = useState(true);
  const [autoStart, setAutoStart] = useState(true);

  const slots = useMemo(() => {
    const next: string[] = [HOST_SLOT];
    for (let i = 2; i <= simCount; i += 1) {
      next.push(`lab_p${i}`);
    }
    return next;
  }, [simCount]);

  const hostRoomStorageKey = slotKey("sultan_room_id", HOST_SLOT);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => {
      const nextRoomId = localStorage.getItem(hostRoomStorageKey) ?? "";
      if (nextRoomId && nextRoomId !== roomId) {
        setRoomId(nextRoomId);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [hostRoomStorageKey, roomId, running]);

  function clearSimulationStorage(): void {
    const allSlots: string[] = [HOST_SLOT];
    for (let i = 2; i <= MAX_PLAYERS; i += 1) {
      allSlots.push(`lab_p${i}`);
    }
    allSlots.forEach((slot) => {
      STORAGE_KEYS.forEach((base) => localStorage.removeItem(slotKey(base, slot)));
    });
  }

  function restartSimulation(): void {
    clearSimulationStorage();
    setRoomId("");
    setRunning(true);
    setBootId((prev) => prev + 1);
  }

  function pauseSimulation(): void {
    setRunning(false);
  }

  return (
    <div className="lab-shell lab-shell-immersive">
      <h1>真实界面单机模拟器</h1>
      <p className="lab-subtitle">每个玩家窗口都在运行正式版页面（圆桌 + 面板），用于 5-15 人真实流程模拟。</p>
      <p className="lab-status">当前房间：{roomId || "等待房主建房..."} | 当前玩家数：{simCount}</p>

      <div className="lab-toolbar">
        <label className="lab-checkbox">
          模拟人数
          <input
            type="number"
            min={MIN_PLAYERS}
            max={MAX_PLAYERS}
            value={simCount}
            onChange={(event) => setSimCount(clampPlayerCount(Number(event.target.value)))}
            className="lab-number"
          />
        </label>
        <label className="lab-checkbox">
          <input type="checkbox" checked={autoReady} onChange={(event) => setAutoReady(event.target.checked)} />
          自动准备
        </label>
        <label className="lab-checkbox">
          <input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} />
          房主自动开局
        </label>
        <button className="lab-btn lab-btn-primary" onClick={restartSimulation}>
          启动 / 重启模拟
        </button>
        <button className="lab-btn lab-btn-ghost" onClick={pauseSimulation}>
          暂停渲染
        </button>
      </div>

      <div className="sim-grid">
        {slots.map((slot, index) => {
          const isHost = index === 0;
          const playerLabel = isHost ? "房主" : `玩家${index + 1}`;
          const canRender = isHost || !!roomId;
          const src = isHost
            ? buildSimUrl({
                slot,
                name: "房主",
                mode: "create",
                autoReady,
                autoStart,
                bootId,
              })
            : canRender
              ? buildSimUrl({
                  slot,
                  name: `玩家${index + 1}`,
                  mode: "join",
                  roomId,
                  autoReady,
                  autoStart: false,
                  bootId,
                })
              : "";

          return (
            <section key={slot} className="sim-card">
              <header className="sim-card-head">
                <strong>
                  {playerLabel} · 槽位 {slot}
                </strong>
                <span>{isHost ? "自动建房" : roomId ? "自动加入" : "等待房间号"}</span>
              </header>
              {!running ? (
                <div className="sim-wait">点击“启动 / 重启模拟”开始。</div>
              ) : !src ? (
                <div className="sim-wait">等待房主创建房间...</div>
              ) : (
                <iframe className="sim-frame" src={src} title={`sim-${slot}`} />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
