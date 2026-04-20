from __future__ import annotations

import time
import uuid
from typing import Any


ROLE_NAME_ZH: dict[str, str] = {
    "sultan": "苏丹",
    "assassin": "刺客",
    "guard": "守卫",
    "slave": "奴隶",
    "oracle": "占卜师",
    "belly_dancer": "肚皮舞娘",
    "slave_trader": "奴隶贩子",
    "grand_official": "大官",
}


def role_name_zh(role: str) -> str:
    return ROLE_NAME_ZH.get(role, role)


def faction_name_zh(faction: str) -> str:
    return "革命党" if faction == "rebels" else "保皇派"


def role_base_faction(role: str) -> str:
    if role in {"sultan", "guard"}:
        return "loyalists"
    if role in {"assassin", "slave"}:
        return "rebels"
    return "neutral"


def effective_faction(player: dict[str, Any]) -> str:
    role = player["card"]["role"]
    if role == "belly_dancer":
        return "rebels" if player["card"]["faceUp"] else "loyalists"
    if role == "slave_trader":
        return "loyalists" if player["card"]["faceUp"] else "rebels"
    return role_base_faction(role)


def circular_adjacent_seat_indices(seat_index: int, seat_count: int) -> tuple[int, int]:
    left = (seat_index - 1 + seat_count) % seat_count
    right = (seat_index + 1) % seat_count
    return left, right


def count_circular_max_run(values: list[bool]) -> int:
    if not values:
        return 0
    if all(values):
        return len(values)

    doubled = values + values
    best = 0
    current = 0
    for item in doubled:
        if item:
            current += 1
            best = max(best, min(current, len(values)))
        else:
            current = 0
    return best


def ensure_effects(state: dict[str, Any]) -> dict[str, Any]:
    effects = state.get("effects")
    if effects is None:
        effects = {}
        state["effects"] = effects
    return effects


def current_player_id(state: dict[str, Any]) -> str:
    return state["seatOrder"][state["turn"]["currentSeatIndex"]]


def mark_updated(state: dict[str, Any]) -> None:
    state["updatedAt"] = int(time.time() * 1000)


def add_log(
    state: dict[str, Any],
    log_type: str,
    message: str,
    actor_id: str | None = None,
    target_id: str | None = None,
) -> None:
    state.setdefault("logs", [])
    state["logs"].append(
        {
            "id": str(uuid.uuid4()),
            "turnSequence": state["turn"]["sequence"],
            "at": int(time.time() * 1000),
            "type": log_type,
            "message": message,
            "actorId": actor_id,
            "targetId": target_id,
        }
    )
    if len(state["logs"]) > 500:
        state["logs"] = state["logs"][-500:]
