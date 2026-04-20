import { useEffect, useMemo, useState } from "react";

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 15;
const HOST_SLOT = "lab_host";
const JOIN_STAGGER_MS = 800;

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
  const [releasedPlayerCount, setReleasedPlayerCount] = useState(1);

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
      setReleasedPlayerCount(1);
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

  useEffect(() => {
    if (!running || !roomId) {
      setReleasedPlayerCount(1);
      return;
    }

    setReleasedPlayerCount(1);
    const timers: number[] = [];
    for (let playerNumber = 2; playerNumber <= simCount; playerNumber += 1) {
      timers.push(
        window.setTimeout(() => {
          setReleasedPlayerCount((prev) => Math.max(prev, playerNumber));
        }, JOIN_STAGGER_MS * (playerNumber - 1)),
      );
    }

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [bootId, roomId, running, simCount]);

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
      <p className="lab-status">
        当前房间：{roomId || "等待房主建房..."} | 当前玩家数：{simCount} | 模拟玩家会按顺序入场，尽量保证“玩家 X”对应 X 号位
      </p>

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
          const playerNumber = index + 1;
          const playerLabel = `玩家${playerNumber}`;
          const released = isHost || playerNumber <= releasedPlayerCount;
          const canRender = released && (isHost || !!roomId);
          const src = isHost
            ? buildSimUrl({
                slot,
                name: "玩家1",
                mode: "create",
                autoReady,
                autoStart,
                bootId,
              })
            : canRender
              ? buildSimUrl({
                  slot,
                  name: `玩家${playerNumber}`,
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
                <span>
                  {isHost
                    ? "1 号位 / 自动建房"
                    : !roomId
                      ? "等待房间号"
                      : released
                        ? `${playerNumber} 号位 / 自动加入`
                        : `等待 ${playerNumber - 1} 号位先加入`}
                </span>
              </header>
              {!running ? (
                <div className="sim-wait">点击“启动 / 重启模拟”开始。</div>
              ) : !src ? (
                <div className="sim-wait">{roomId ? "正在按顺序安排玩家入场..." : "等待房主创建房间..."}</div>
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
