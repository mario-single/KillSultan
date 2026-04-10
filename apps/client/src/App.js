import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3000";
const TOKEN_KEY = "sultan_token";
const ROOM_KEY = "sultan_room_id";
const NAME_KEY = "sultan_name";
function unwrapAck(result) {
    if (result.ok) {
        return result.data;
    }
    throw new Error(`${result.error.code}: ${result.error.message}`);
}
export function App() {
    const socketRef = useRef(null);
    const [playerName, setPlayerName] = useState(localStorage.getItem(NAME_KEY) ?? "");
    const [roomIdInput, setRoomIdInput] = useState(localStorage.getItem(ROOM_KEY) ?? "");
    const [token, setToken] = useState(localStorage.getItem(TOKEN_KEY) ?? "");
    const [myPlayerId, setMyPlayerId] = useState("");
    const [scopedState, setScopedState] = useState(null);
    const [errors, setErrors] = useState([]);
    const [privateFeed, setPrivateFeed] = useState([]);
    const [selectedTarget, setSelectedTarget] = useState("");
    const [oraclePrediction, setOraclePrediction] = useState("rebels");
    const [followerInput, setFollowerInput] = useState("");
    const [triggerGlobalSwap, setTriggerGlobalSwap] = useState(false);
    useEffect(() => {
        const socket = io(SERVER_URL, { transports: ["websocket"] });
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
                }
                catch (err) {
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
    function addError(message) {
        setErrors((prev) => [message, ...prev].slice(0, 20));
    }
    function createRoom() {
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
            }
            catch (err) {
                addError(String(err));
            }
        });
    }
    function joinRoom() {
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
        socket.emit("room:join", {
            roomId: roomIdInput.trim().toUpperCase(),
            playerName: playerName.trim(),
            token: token || undefined,
        }, (result) => {
            try {
                const data = unwrapAck(result);
                setToken(data.token);
                setMyPlayerId(data.playerId);
                localStorage.setItem(TOKEN_KEY, data.token);
                localStorage.setItem(ROOM_KEY, data.roomId);
                localStorage.setItem(NAME_KEY, playerName.trim());
            }
            catch (err) {
                addError(String(err));
            }
        });
    }
    function toggleReady() {
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
    function startGame() {
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
    function doPeek() {
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
    function doSwap() {
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
    function doSwapCenter() {
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
    function doReveal() {
        const socket = socketRef.current;
        if (!socket || !publicState) {
            return;
        }
        const followerIds = followerInput
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        socket.emit("action:reveal", {
            roomId: publicState.roomId,
            targetPlayerId: selectedTarget || undefined,
            oraclePrediction,
            followerIds: followerIds.length > 0 ? followerIds : undefined,
            triggerGlobalSwap,
        }, (result) => {
            if (!result.ok) {
                addError(`${result.error.code}: ${result.error.message}`);
            }
        });
    }
    function leaveRoom() {
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
        return (_jsxs("div", { className: "shell", children: [_jsxs("div", { className: "hero", children: [_jsx("h1", { children: "Sultan Online" }), _jsx("p", { children: "Realtime hidden-identity game prototype" })] }), _jsxs("div", { className: "card", children: [_jsx("label", { children: "Player Name" }), _jsx("input", { value: playerName, onChange: (e) => setPlayerName(e.target.value) }), _jsx("label", { children: "Room ID (for join)" }), _jsx("input", { value: roomIdInput, onChange: (e) => setRoomIdInput(e.target.value.toUpperCase()) }), _jsxs("div", { className: "row", children: [_jsx("button", { onClick: createRoom, children: "Create Room" }), _jsx("button", { onClick: joinRoom, children: "Join Room" })] })] }), _jsx(ErrorFeed, { errors: errors })] }));
    }
    const actionDisabled = publicState.phase !== "in_game" || !isMyTurn;
    return (_jsxs("div", { className: "shell", children: [_jsxs("header", { className: "topbar", children: [_jsxs("h1", { children: ["Room ", publicState.roomId] }), _jsxs("div", { className: "topbar-meta", children: [_jsxs("span", { children: ["You: ", me?.name] }), _jsxs("span", { children: ["Role: ", privateState?.selfRole] }), _jsx("button", { onClick: leaveRoom, children: "Leave" })] })] }), _jsxs("section", { className: "grid", children: [_jsxs("article", { className: "panel", children: [_jsx("h2", { children: "Players" }), _jsx("ul", { children: publicState.players.map((player) => (_jsxs("li", { className: player.id === currentPlayerId ? "active" : "", children: [_jsx("button", { onClick: () => setSelectedTarget(player.id), children: player.name }), _jsx("span", { children: player.alive ? "alive" : "dead" }), _jsx("span", { children: player.cardFaceUp ? `face-up:${player.revealedRole}` : "face-down" }), _jsx("span", { children: player.skipActions > 0 ? "detained" : "free" })] }, player.id))) }), publicState.phase === "lobby" ? (_jsxs("div", { className: "row", children: [_jsx("button", { onClick: toggleReady, children: me?.ready ? "Unready" : "Ready" }), publicState.hostPlayerId === myPlayerId ? _jsx("button", { onClick: startGame, children: "Start Game" }) : null] })) : (_jsxs("div", { children: [_jsxs("p", { children: ["Round ", publicState.turn.round] }), _jsxs("p", { children: ["Turn: ", publicState.players.find((player) => player.id === currentPlayerId)?.name] })] })), publicState.winner ? (_jsxs("p", { className: "winner", children: ["Winner: ", publicState.winner.winnerFaction, " | ", publicState.winner.reason] })) : null] }), _jsxs("article", { className: "panel", children: [_jsx("h2", { children: "Actions" }), _jsxs("p", { children: ["Target: ", selectedTarget || "-"] }), _jsxs("div", { className: "row", children: [_jsx("button", { disabled: actionDisabled || !selectedTarget, onClick: doPeek, children: "Peek" }), _jsx("button", { disabled: actionDisabled || !selectedTarget, onClick: doSwap, children: "Swap" }), _jsx("button", { disabled: actionDisabled, onClick: doSwapCenter, children: "Swap Center" })] }), _jsx("label", { children: "Oracle Prediction" }), _jsxs("select", { value: oraclePrediction, onChange: (e) => setOraclePrediction(e.target.value), disabled: actionDisabled, children: [_jsx("option", { value: "rebels", children: "rebels" }), _jsx("option", { value: "loyalists", children: "loyalists" })] }), _jsx("label", { children: "Slave Followers (comma ids)" }), _jsx("input", { value: followerInput, onChange: (e) => setFollowerInput(e.target.value) }), _jsxs("label", { className: "checkbox", children: [_jsx("input", { type: "checkbox", checked: triggerGlobalSwap, onChange: (e) => setTriggerGlobalSwap(e.target.checked), disabled: actionDisabled }), "Belly Dancer global swap (if extension enabled)"] }), _jsx("button", { disabled: actionDisabled, onClick: doReveal, children: "Reveal" })] }), _jsxs("article", { className: "panel", children: [_jsx("h2", { children: "Private Intel" }), _jsxs("p", { children: ["Self role: ", privateState?.selfRole] }), _jsxs("p", { children: ["Card face: ", privateState?.selfCardFaceUp ? "up" : "down"] }), _jsxs("p", { children: ["Oracle prediction: ", privateState?.oraclePrediction ?? "-"] }), _jsx("ul", { children: privateState?.privateKnowledge.map((note, idx) => (_jsxs("li", { children: [note.source, " saw ", note.subjectType, ":", note.subjectId, " = ", note.role] }, `${note.subjectType}-${note.subjectId}-${idx}`))) })] }), _jsxs("article", { className: "panel", children: [_jsx("h2", { children: "Logs" }), _jsx("ul", { children: publicState.logs.map((log) => (_jsx("li", { children: log.message }, log.id))) })] }), _jsxs("article", { className: "panel", children: [_jsx("h2", { children: "Private Feed" }), _jsx("ul", { children: privateFeed.map((line, index) => (_jsx("li", { children: line }, `${line}-${index}`))) })] })] }), _jsx(ErrorFeed, { errors: errors })] }));
}
function ErrorFeed(props) {
    if (props.errors.length === 0) {
        return null;
    }
    return (_jsx("section", { className: "errors", children: props.errors.map((error, index) => (_jsx("p", { children: error }, `${error}-${index}`))) }));
}
