from __future__ import annotations

import random
from typing import Any

from errors import CoreRulesError


NEUTRAL_POOL = ["oracle", "belly_dancer", "slave_trader", "grand_official"]

DECK_PROFILE_BY_PLAYERS: dict[int, dict[str, int]] = {
    5: {"sultan": 1, "guard": 1, "assassin": 1, "slave": 3, "neutral": 0},
    6: {"sultan": 1, "guard": 1, "assassin": 1, "slave": 3, "neutral": 1},
    7: {"sultan": 1, "guard": 1, "assassin": 1, "slave": 3, "neutral": 2},
    8: {"sultan": 1, "guard": 2, "assassin": 2, "slave": 3, "neutral": 1},
    9: {"sultan": 1, "guard": 2, "assassin": 2, "slave": 3, "neutral": 2},
    10: {"sultan": 1, "guard": 2, "assassin": 2, "slave": 3, "neutral": 3},
    11: {"sultan": 1, "guard": 2, "assassin": 2, "slave": 4, "neutral": 3},
    12: {"sultan": 1, "guard": 3, "assassin": 3, "slave": 4, "neutral": 2},
    13: {"sultan": 1, "guard": 3, "assassin": 3, "slave": 4, "neutral": 3},
    14: {"sultan": 1, "guard": 3, "assassin": 3, "slave": 4, "neutral": 4},
    15: {"sultan": 1, "guard": 3, "assassin": 3, "slave": 5, "neutral": 4},
}


def build_deck(player_count: int) -> list[str]:
    profile = DECK_PROFILE_BY_PLAYERS.get(player_count)
    if not profile:
        raise CoreRulesError("INVALID_PLAYER_COUNT", f"unsupported player count: {player_count}")

    deck: list[str] = []
    deck.extend(["sultan"] * profile["sultan"])
    deck.extend(["guard"] * profile["guard"])
    deck.extend(["assassin"] * profile["assassin"])
    deck.extend(["slave"] * profile["slave"])

    if profile["neutral"] > len(NEUTRAL_POOL):
        raise CoreRulesError("INVALID_DECK_PROFILE", "neutral role pool is smaller than requested neutral count")

    deck.extend(random.sample(NEUTRAL_POOL, profile["neutral"]))

    expected_cards = player_count + 1
    if len(deck) != expected_cards:
        raise CoreRulesError(
            "INVALID_DECK_PROFILE",
            f"invalid deck profile: expected {expected_cards} cards, got {len(deck)}",
        )

    random.shuffle(deck)
    return deck


def create_card(role: str, version_seed: int = 1) -> dict[str, Any]:
    return {
        "role": role,
        "faceUp": False,
        "version": version_seed,
    }
