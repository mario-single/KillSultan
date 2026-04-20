from __future__ import annotations

from copy import deepcopy
import random
import time
from typing import Any

from errors import CoreRulesError
from helpers import (
    add_log,
    circular_adjacent_seat_indices,
    count_circular_max_run,
    current_player_id,
    effective_faction,
    faction_name_zh,
    mark_updated,
    role_name_zh,
)
from setup import build_deck, create_card

TURN_TIMEOUT_MS = 60_000
UPRISING_RESPONSE_TIMEOUT_MS = 15_000


class CoreRulesEngine:
    def dispatch(self, command: str, request: dict[str, Any]) -> dict[str, Any]:
        state = deepcopy(request["state"])

        if command == "start_game":
            self.start_game(state, request["actorId"])
            return {"state": state}
        if command == "action_peek":
            private_notice = self.handle_peek(state, request["actorId"], request["targetPlayerId"])
            return {"state": state, "privateNotice": private_notice}
        if command == "action_swap":
            self.handle_swap(state, request["actorId"], request["targetPlayerId"])
            return {"state": state}
        if command == "action_swap_center":
            self.handle_swap_center(state, request["actorId"])
            return {"state": state}
        if command == "action_reveal":
            private_notice = self.handle_reveal(state, request["actorId"], request.get("payload", {}))
            return {"state": state, "privateNotice": private_notice}
        if command == "action_decline_follow":
            self.handle_decline_follow(state, request["actorId"])
            return {"state": state}
        if command == "action_oracle_prediction":
            self.handle_oracle_prediction(state, request["actorId"], request["prediction"])
            return {"state": state}
        if command == "action_end_turn":
            self.handle_end_turn(state, request["actorId"])
            return {"state": state}
        if command == "action_slave_trader_pick":
            private_notice = self.handle_slave_trader_pick(state, request["actorId"], request["targetPlayerId"])
            return {"state": state, "privateNotice": private_notice}
        if command == "disconnect":
            self.handle_disconnect(state, request["playerId"])
            return {"state": state}
        if command == "timeout":
            self.handle_timeout(state)
            return {"state": state}

        raise CoreRulesError("UNKNOWN_COMMAND", f"unsupported core rules command: {command}")

    def start_game(self, state: dict[str, Any], actor_id: str) -> None:
        if state["phase"] != "lobby":
            raise CoreRulesError("GAME_ALREADY_STARTED", "游戏已经开始。")
        if state["hostPlayerId"] != actor_id:
            raise CoreRulesError("NOT_HOST", "只有房主可以开始游戏。")

        min_players = state["settings"]["minPlayers"]
        max_players = state["settings"]["maxPlayers"]
        player_count = len(state["seatOrder"])
        if player_count < min_players or player_count > max_players:
            raise CoreRulesError("INVALID_PLAYER_COUNT", f"玩家人数必须在 {min_players} 到 {max_players} 之间。")

        unready = next((pid for pid in state["seatOrder"] if not state["players"][pid]["ready"]), None)
        if unready:
            raise CoreRulesError("PLAYERS_NOT_READY", "开始前需要所有玩家都准备。")

        deck = build_deck(player_count)
        for index, player_id in enumerate(state["seatOrder"]):
            player = state["players"][player_id]
            player["card"] = create_card(deck[index], 1)
            player["alive"] = True
            player["skipActions"] = 0
            player["privateKnowledge"] = []
            player["oraclePrediction"] = None

        state["centerCard"] = create_card(deck[-1], 1)
        state["turn"] = {"currentSeatIndex": 0, "round": 1, "sequence": 1}
        state["phase"] = "in_game"
        state["winner"] = None
        state["effects"] = {
            "turnDeadlineAt": int(time.time() * 1000) + TURN_TIMEOUT_MS,
        }
        add_log(state, "system", "游戏开始，身份已发放。")
        add_log(state, "turn", f"第 {state['turn']['round']} 轮，轮到 {state['players'][self.current_player_id(state)]['name']} 行动。")
        mark_updated(state)

    def handle_peek(self, state: dict[str, Any], actor_id: str, target_player_id: str) -> dict[str, Any]:
        self.assert_action_turn(state, actor_id)
        actor = self.get_player_or_throw(state, actor_id)
        target = self.get_player_or_throw(state, target_player_id)
        if not target["alive"]:
            raise CoreRulesError("TARGET_DEAD", "不能偷看已死亡玩家。")
        if actor["id"] == target["id"]:
            raise CoreRulesError("INVALID_TARGET", "不能偷看自己。")

        actor.setdefault("privateKnowledge", []).append(
            {
                "subjectType": "player",
                "subjectId": target["id"],
                "role": target["card"]["role"],
                "observedVersion": target["card"]["version"],
                "source": "peek",
                "turnSequence": state["turn"]["sequence"],
            }
        )
        self.trim_knowledge(actor)
        add_log(state, "peek", f"{actor['name']} 发动了偷看，目标是 {target['name']}。", actor["id"], target["id"])
        self.finish_action_and_advance(state)
        mark_updated(state)
        return {
            "message": f"偷看结果：{target['name']} 的身份是 {role_name_zh(target['card']['role'])}。",
            "detail": {
                "targetPlayerId": target["id"],
                "role": target["card"]["role"],
                "roleNameZh": role_name_zh(target["card"]["role"]),
            },
        }

    def handle_swap(self, state: dict[str, Any], actor_id: str, target_player_id: str) -> None:
        self.assert_action_turn(state, actor_id)
        actor = self.get_player_or_throw(state, actor_id)
        target = self.get_player_or_throw(state, target_player_id)
        if not target["alive"]:
            raise CoreRulesError("TARGET_DEAD", "不能与已死亡玩家交换。")
        if target["id"] == actor["id"]:
            raise CoreRulesError("INVALID_TARGET", "不能与自己交换。")
        if target["card"]["faceUp"]:
            raise CoreRulesError("FACE_UP_FORBIDDEN", "不能交换明牌目标。")
        self.assert_no_immediate_swap_back(state, actor["id"], target["id"])

        actor_card = dict(actor["card"])
        target_card = dict(target["card"])
        actor["card"] = {**target_card, "version": target_card["version"] + 1}
        target["card"] = {**actor_card, "version": actor_card["version"] + 1}
        effects = state.setdefault("effects", {})
        effects["noSwapBackA"] = actor["id"]
        effects["noSwapBackB"] = target["id"]
        effects["noSwapBackSequence"] = self.next_turn_sequence_for_player(state, actor["id"], target["id"])
        effects["noSwapBackProtectedVersion"] = actor["card"]["version"]
        add_log(state, "swap", f"{actor['name']} 与 {target['name']} 交换了身份牌。", actor["id"], target["id"])
        self.finish_action_and_advance(state)
        mark_updated(state)

    def handle_swap_center(self, state: dict[str, Any], actor_id: str) -> None:
        self.assert_action_turn(state, actor_id)
        actor = self.get_player_or_throw(state, actor_id)
        if state["centerCard"]["faceUp"]:
            raise CoreRulesError("FACE_UP_FORBIDDEN", "不能与明牌状态的中间牌交换。")
        if not actor["alive"]:
            raise CoreRulesError("ACTOR_DEAD", "死亡玩家不能行动。")

        actor_card = dict(actor["card"])
        center_card = dict(state["centerCard"])
        actor["card"] = {**center_card, "version": center_card["version"] + 1}
        state["centerCard"] = {**actor_card, "version": actor_card["version"] + 1}
        add_log(state, "swap_center", f"{actor['name']} 与中间牌交换了身份牌。", actor["id"])
        self.finish_action_and_advance(state)
        mark_updated(state)

    def handle_reveal(self, state: dict[str, Any], actor_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        actor = self.get_player_or_throw(state, actor_id)
        pending_uprising = state.get("effects", {}).get("pendingSlaveUprising")

        if pending_uprising and pending_uprising.get("stage") == "follow" and actor_id in pending_uprising.get("waitingPlayerIds", []):
            return self.handle_slave_follow_reveal(state, actor, pending_uprising)

        is_sultan = actor["card"]["role"] == "sultan"
        crown_anytime = self.can_sultan_crown_anytime(state, actor, payload)
        was_face_up = actor["card"]["faceUp"]

        if not crown_anytime:
            self.assert_action_turn(state, actor_id)

        if was_face_up and not is_sultan:
            raise CoreRulesError("ALREADY_REVEALED", "该身份牌已经公开。")

        self.validate_reveal_payload(state, actor, payload, 0)

        if not was_face_up:
            actor["card"]["faceUp"] = True
            actor["card"]["version"] += 1
            add_log(state, "reveal", f"{actor['name']} 公开了身份牌，身份是{role_name_zh(actor['card']['role'])}。", actor["id"])

        private_notice = self.execute_role_skill(state, actor["id"], payload, forced=False, depth=0)

        if not crown_anytime:
            if actor["card"]["role"] == "oracle":
                mark_updated(state)
                return private_notice
            if is_sultan and was_face_up and not payload.get("targetPlayerId"):
                add_log(state, "skill", f"{actor['name']} 选择不处决任何目标，直接结束了本回合。", actor["id"])
            if not state.get("effects", {}).get("pendingSlaveUprising"):
                self.finish_action_and_advance(state)
        else:
            add_log(state, "skill", f"{actor['name']} 在非自己回合完成了加冕公开。", actor["id"])

        mark_updated(state)
        return private_notice

    def handle_decline_follow(self, state: dict[str, Any], actor_id: str) -> None:
        pending_uprising = state.get("effects", {}).get("pendingSlaveUprising")
        if not pending_uprising or actor_id not in pending_uprising.get("waitingPlayerIds", []):
            raise CoreRulesError("NO_PENDING_FOLLOW", "当前没有等待你响应的起义跟随。")
        self.resolve_slave_uprising_response(state, actor_id, join_uprising=False)
        mark_updated(state)

    def handle_disconnect(self, state: dict[str, Any], player_id: str) -> None:
        player = state["players"].get(player_id)
        if not player:
            return

        player["connected"] = False
        add_log(state, "system", f"{player['name']} 断开连接", player["id"])

        if (
            state["phase"] == "in_game"
            and not state.get("winner")
            and player_id in state.get("effects", {}).get("pendingSlaveUprising", {}).get("waitingPlayerIds", [])
        ):
            add_log(state, "skill", f"{player['name']} 当前离线，视为放弃跟随起义。", player["id"])
            self.resolve_slave_uprising_response(state, player_id, join_uprising=False)

        if state.get("effects", {}).get("pendingSlaveTrader", {}).get("playerId") == player_id:
            state["effects"].pop("pendingSlaveTrader", None)

        mark_updated(state)

    def handle_oracle_prediction(self, state: dict[str, Any], actor_id: str, prediction: str) -> None:
        pending_oracle = state.get("effects", {}).get("pendingOraclePrediction")
        if not pending_oracle or pending_oracle.get("playerId") != actor_id:
            raise CoreRulesError("NO_PENDING_ORACLE_PREDICTION", "当前没有等待你公开的预言。")

        actor = self.get_player_or_throw(state, actor_id)
        if actor["card"]["role"] != "oracle" or not actor["card"]["faceUp"]:
            raise CoreRulesError("INVALID_ORACLE_STATE", "当前不能公开预言。")
        if prediction not in {"rebels", "loyalists"}:
            raise CoreRulesError("INVALID_PREDICTION", "预言阵营无效。")

        actor["oraclePrediction"] = prediction
        state["effects"].pop("pendingOraclePrediction", None)
        add_log(state, "skill", f"{actor['name']} 公开预言：{faction_name_zh(prediction)}将获胜。", actor["id"])
        self.finish_action_and_advance(state)
        mark_updated(state)

    def handle_end_turn(self, state: dict[str, Any], actor_id: str) -> None:
        pending_uprising = state.get("effects", {}).get("pendingSlaveUprising")
        if not pending_uprising or pending_uprising.get("stage") != "await_end_turn":
            raise CoreRulesError("END_TURN_NOT_ALLOWED", "当前没有可手动结束的回合。")
        if pending_uprising.get("initiatorPlayerId") != actor_id:
            raise CoreRulesError("END_TURN_NOT_ALLOWED", "只有起义发起者可以结束当前回合。")

        actor = self.get_player_or_throw(state, actor_id)
        state["effects"].pop("pendingSlaveUprising", None)
        add_log(state, "turn", f"{actor['name']} 结束了本回合。", actor["id"])
        self.finish_action_and_advance(state)
        mark_updated(state)

    def handle_slave_trader_pick(
        self,
        state: dict[str, Any],
        actor_id: str,
        target_player_id: str,
    ) -> dict[str, Any]:
        pending_slave_trader = state.get("effects", {}).get("pendingSlaveTrader")
        if not pending_slave_trader or pending_slave_trader.get("playerId") != actor_id:
            raise CoreRulesError("NO_PENDING_SLAVE_TRADER", "当前没有等待你执行的奴隶贩子技能。")

        actor = self.get_player_or_throw(state, actor_id)
        target = self.get_player_or_throw(state, target_player_id)
        if target["id"] == actor["id"]:
            raise CoreRulesError("INVALID_TARGET", "奴隶贩子不能选择自己。")
        if not target["alive"]:
            raise CoreRulesError("INVALID_TARGET", "目标已经死亡。")
        if target["id"] in pending_slave_trader["checkedPlayerIds"]:
            raise CoreRulesError("INVALID_TARGET", "本轮已经检查过该玩家。")

        pending_slave_trader["checkedPlayerIds"].append(target["id"])
        add_log(state, "skill", f"{actor['name']} 检查了 {target['name']}。", actor["id"], target["id"])

        if target["card"]["role"] == "slave":
            target["skipActions"] += 1
            self.reveal_player(state, target, actor["id"])
            add_log(state, "detain", f"{actor['name']} 识别出奴隶并拘留了 {target['name']}。", actor["id"], target["id"])
            mark_updated(state)
            return {
                "message": f"检查结果：{target['name']} 是奴隶，你可以继续选择下一名玩家。",
                "detail": {
                    "targetPlayerId": target["id"],
                    "isSlave": True,
                },
            }

        state["effects"].pop("pendingSlaveTrader", None)
        add_log(state, "skill", f"{actor['name']} 检查结果：{target['name']} 并非奴隶，技能结束。", actor["id"], target["id"])
        self.finish_action_and_advance(state)
        mark_updated(state)
        return {
            "message": f"检查结果：{target['name']} 不是奴隶，回合结束。",
            "detail": {
                "targetPlayerId": target["id"],
                "isSlave": False,
            },
        }

    def reveal_player(self, state: dict[str, Any], player: dict[str, Any], by_actor_id: str | None = None) -> bool:
        if player["card"]["faceUp"]:
            return False
        player["card"]["faceUp"] = True
        player["card"]["version"] += 1
        add_log(
            state,
            "reveal",
            f"{player['name']} 暴露了身份，身份是{role_name_zh(player['card']['role'])}。",
            by_actor_id,
            player["id"],
        )
        return True

    def handle_slave_follow_reveal(
        self,
        state: dict[str, Any],
        actor: dict[str, Any],
        pending_uprising: dict[str, Any],
    ) -> None:
        if actor["card"]["role"] != "slave":
            raise CoreRulesError("INVALID_FOLLOW", "当前只有奴隶可以响应起义跟随。")
        if actor["card"]["faceUp"]:
            raise CoreRulesError("ALREADY_REVEALED", "该奴隶已经公开，不能重复跟随。")
        if not actor["alive"]:
            raise CoreRulesError("ACTOR_DEAD", "死亡玩家不能跟随起义。")
        if not actor["connected"]:
            raise CoreRulesError("PLAYER_OFFLINE", "离线玩家不能跟随起义。")

        actor["card"]["faceUp"] = True
        actor["card"]["version"] += 1
        add_log(
            state,
            "reveal",
            f"{actor['name']} 跟随起义公开了身份牌，身份是{role_name_zh(actor['card']['role'])}。",
            actor["id"],
            pending_uprising["initiatorPlayerId"],
        )
        self.resolve_slave_uprising_response(state, actor["id"], join_uprising=True)
        mark_updated(state)
        return None

    def execute_role_skill(
        self,
        state: dict[str, Any],
        actor_id: str,
        payload: dict[str, Any],
        *,
        forced: bool,
        depth: int,
    ) -> dict[str, Any] | None:
        actor = self.get_player_or_throw(state, actor_id)

        def fail(code: str, message: str) -> bool:
            if not forced:
                raise CoreRulesError(code, message)
            add_log(state, "skill", f"{actor['name']} 的被强制技能未生效：{message}", actor["id"])
            return True

        role = actor["card"]["role"]
        if role == "sultan":
            effects = state.setdefault("effects", {})
            if effects.get("sultanPlayerId") != actor["id"] or effects.get("sultanCrownedRound") is None:
                effects["sultanPlayerId"] = actor["id"]
                effects["sultanCrownedRound"] = state["turn"]["round"]
                add_log(state, "skill", f"{actor['name']} 完成加冕，成为明牌苏丹。", actor["id"])
            target_id = payload.get("targetPlayerId")
            if target_id:
                target = self.get_player_or_throw(state, target_id)
                add_log(state, "skill", f"{actor['name']} 选择处决 {target['name']}。", actor["id"], target["id"])
                if not target["card"]["faceUp"] and fail("INVALID_EXECUTION_TARGET", "苏丹只能处决已公开目标。"):
                    return None
                if effective_faction(target) != "rebels" and fail(
                    "INVALID_EXECUTION_TARGET", "目标不是公开的革命阵营角色。"
                ):
                    return None
                if not target["alive"] and fail("INVALID_EXECUTION_TARGET", "目标已经死亡。"):
                    return None
                target["alive"] = False
                target["card"]["faceUp"] = True
                target["card"]["version"] += 1
                add_log(state, "death", f"{actor['name']} 处决了 {target['name']}", actor["id"], target["id"])
            return None

        if role == "assassin":
            target_id = payload.get("targetPlayerId")
            if not target_id and fail("MISSING_TARGET", "刺客公开时必须指定刺杀目标。"):
                return None
            target = self.get_player_or_throw(state, target_id)
            add_log(state, "skill", f"{actor['name']} 选择刺杀 {target['name']}。", actor["id"], target["id"])
            if not target["alive"] and fail("INVALID_TARGET", "目标已经死亡。"):
                return None
            if target["id"] == actor["id"] and fail("INVALID_TARGET", "刺客不能刺杀自己。"):
                return None
            guards = self.find_protecting_guards(state, actor["id"], target["id"])
            if guards:
                actor["alive"] = False
                self.reveal_player(state, actor)
                guard_id = random.choice(guards)
                guard = self.get_player_or_throw(state, guard_id)
                self.reveal_player(state, guard, actor["id"])
                add_log(state, "skill", f"{guard['name']} 拦截了 {actor['name']} 对 {target['name']} 的刺杀。", guard["id"], target["id"])
                add_log(state, "death", f"刺杀失败：{actor['name']} 被守卫反制并死亡。", actor["id"])
            else:
                target["alive"] = False
                self.reveal_player(state, target, actor["id"])
                add_log(state, "death", f"{actor['name']} 成功刺杀了 {target['name']}", actor["id"], target["id"])
                if target["card"]["role"] == "sultan":
                    state.setdefault("effects", {})["sultanKilledByAssassin"] = True
                    state["effects"]["assassinKillerPlayerId"] = actor["id"]
            return None

        if role == "guard":
            target_id = payload.get("targetPlayerId")
            if not target_id and fail("MISSING_TARGET", "守卫公开时必须指定拘留目标。"):
                return None
            target = self.get_player_or_throw(state, target_id)
            add_log(state, "skill", f"{actor['name']} 发动拘留，目标是 {target['name']}。", actor["id"], target["id"])
            if not target["alive"] and fail("INVALID_TARGET", "目标已经死亡。"):
                return None
            if self.is_guard_charmed(state, actor["id"]):
                add_log(state, "skill", f"{actor['name']} 的拘留失败：被肚皮舞娘魅惑。", actor["id"], target["id"])
                return None
            if target["card"]["role"] in {"sultan", "guard"}:
                add_log(state, "skill", f"{actor['name']} 的拘留失败：{target['name']} 对拘留免疫。", actor["id"], target["id"])
                return None
            target["skipActions"] += 1
            add_log(state, "detain", f"{actor['name']} 拘留了 {target['name']}。", actor["id"], target["id"])
            return None

        if role == "slave":
            self.start_slave_uprising(state, actor["id"])
            return None

        if role == "oracle":
            subjects = payload.get("inspectSubjects") or self.pick_default_oracle_subjects(state, actor["id"])
            selected = subjects[:3]
            inspected: list[dict[str, Any]] = []
            for subject in selected:
                if subject["subjectType"] == "center":
                    actor.setdefault("privateKnowledge", []).append(
                        {
                            "subjectType": "center",
                            "subjectId": "center",
                            "role": state["centerCard"]["role"],
                            "observedVersion": state["centerCard"]["version"],
                            "source": "oracle",
                            "turnSequence": state["turn"]["sequence"],
                        }
                    )
                    inspected.append({"subjectType": "center", "subjectId": "center", "role": state["centerCard"]["role"]})
                    continue

                target = self.get_player_or_throw(state, subject["subjectId"])
                actor.setdefault("privateKnowledge", []).append(
                    {
                        "subjectType": "player",
                        "subjectId": target["id"],
                        "role": target["card"]["role"],
                        "observedVersion": target["card"]["version"],
                        "source": "oracle",
                        "turnSequence": state["turn"]["sequence"],
                    }
                )
                inspected.append({"subjectType": "player", "subjectId": target["id"], "role": target["card"]["role"]})

            self.trim_knowledge(actor)
            if forced:
                prediction = payload.get("oraclePrediction")
                if not prediction and fail("MISSING_PREDICTION", "占卜师必须选择预言阵营。"):
                    return None
                actor["oraclePrediction"] = prediction
                add_log(state, "skill", f"{actor['name']} 发动了占卜，并公开预言：{faction_name_zh(prediction)}将获胜。", actor["id"])
                return None

            state.setdefault("effects", {})["pendingOraclePrediction"] = {"playerId": actor["id"]}
            add_log(state, "skill", f"{actor['name']} 发动了占卜，正在查看三名玩家的身份。", actor["id"])
            if not forced:
                return {
                    "message": "占卜结果已更新，请根据结果公开预言阵营。",
                    "detail": {
                        "inspected": [
                            {**item, "roleNameZh": role_name_zh(item["role"])}
                            for item in inspected
                        ],
                    },
                }
            return None

        if role == "belly_dancer":
            add_log(state, "skill", f"{actor['name']} 公开为肚皮舞娘，相邻守卫会失效。", actor["id"])
            return None

        if role == "slave_trader":
            state.setdefault("effects", {})["pendingSlaveTrader"] = {
                "playerId": actor["id"],
                "checkedPlayerIds": [],
            }
            add_log(state, "skill", f"{actor['name']} 公开并开始执行奴隶贩子技能。", actor["id"])
            if not forced:
                return {
                    "message": "奴隶贩子技能已开始，请选择一名玩家进行检查。",
                }
            return None

        if role == "grand_official":
            target_id = payload.get("targetPlayerId")
            if not target_id and fail("MISSING_TARGET", "大官必须指定被强制执行技能的玩家。"):
                return None
            if depth >= 2:
                add_log(state, "skill", f"{actor['name']} 的强制技能层级过深，已终止。", actor["id"])
                return None
            target = self.get_player_or_throw(state, target_id)
            if not target["alive"] and fail("INVALID_TARGET", "被强制执行技能的目标已死亡。"):
                return None
            add_log(state, "skill", f"{actor['name']} 强制 {target['name']} 执行技能", actor["id"], target["id"])
            self.force_reveal_and_execute_skill(state, actor["id"], target["id"], payload.get("forceSkill") or {}, depth + 1)
            return None

        return None

    def force_reveal_and_execute_skill(
        self,
        state: dict[str, Any],
        by_player_id: str,
        target_player_id: str,
        force_payload: dict[str, Any],
        depth: int,
    ) -> None:
        by_player = self.get_player_or_throw(state, by_player_id)
        target = self.get_player_or_throw(state, target_player_id)
        if not target["alive"]:
            add_log(state, "skill", f"{by_player['name']} 的强制技能失败：目标已死亡。", by_player["id"], target["id"])
            return

        if not target["card"]["faceUp"]:
            target["card"]["faceUp"] = True
            target["card"]["version"] += 1
            add_log(
                state,
                "reveal",
                f"{target['name']} 被强制公开身份牌，身份是{role_name_zh(target['card']['role'])}。",
                by_player["id"],
                target["id"],
            )

        converted_payload = {
            "targetPlayerId": force_payload.get("targetPlayerId"),
            "followerIds": force_payload.get("followerIds"),
            "slaveTraderTargets": force_payload.get("slaveTraderTargets"),
            "oraclePrediction": force_payload.get("oraclePrediction"),
            "inspectSubjects": force_payload.get("inspectSubjects"),
            "forceSkill": force_payload,
        }
        self.execute_role_skill(state, target["id"], converted_payload, forced=True, depth=depth)

    def validate_reveal_payload(
        self,
        state: dict[str, Any],
        actor: dict[str, Any],
        payload: dict[str, Any],
        depth: int,
    ) -> None:
        role = actor["card"]["role"]
        if role == "sultan":
            target_id = payload.get("targetPlayerId")
            if not target_id:
                return
            target = self.get_player_or_throw(state, target_id)
            if not target["card"]["faceUp"]:
                raise CoreRulesError("INVALID_EXECUTION_TARGET", "苏丹只能处决已公开目标。")
            if effective_faction(target) != "rebels":
                raise CoreRulesError("INVALID_EXECUTION_TARGET", "目标不是公开的革命阵营角色。")
            if not target["alive"]:
                raise CoreRulesError("INVALID_EXECUTION_TARGET", "目标已经死亡。")
            return

        if role == "assassin":
            target_id = payload.get("targetPlayerId")
            if not target_id:
                raise CoreRulesError("MISSING_TARGET", "刺客公开时必须指定刺杀目标。")
            target = self.get_player_or_throw(state, target_id)
            if not target["alive"]:
                raise CoreRulesError("INVALID_TARGET", "目标已经死亡。")
            if target["id"] == actor["id"]:
                raise CoreRulesError("INVALID_TARGET", "刺客不能刺杀自己。")
            return

        if role == "guard":
            target_id = payload.get("targetPlayerId")
            if not target_id:
                raise CoreRulesError("MISSING_TARGET", "守卫公开时必须指定拘留目标。")
            target = self.get_player_or_throw(state, target_id)
            if not target["alive"]:
                raise CoreRulesError("INVALID_TARGET", "目标已经死亡。")
            return

        if role == "oracle":
            if depth > 0:
                if not payload.get("oraclePrediction"):
                    raise CoreRulesError("MISSING_PREDICTION", "占卜师必须选择预言阵营。")
                for subject in payload.get("inspectSubjects") or []:
                    if subject["subjectType"] == "player":
                        self.get_player_or_throw(state, subject["subjectId"])
                return

            inspect_subjects = payload.get("inspectSubjects") or []
            if len(inspect_subjects) != 3:
                raise CoreRulesError("INVALID_INSPECT_SUBJECTS", "占卜师必须选择三名玩家进行观察。")
            seen_subject_ids: set[str] = set()
            for subject in inspect_subjects:
                if subject.get("subjectType") != "player":
                    raise CoreRulesError("INVALID_INSPECT_SUBJECTS", "占卜师本次只能选择三名玩家，不能看中间牌。")
                subject_id = subject["subjectId"]
                if subject_id == actor["id"]:
                    raise CoreRulesError("INVALID_INSPECT_SUBJECTS", "占卜师不能观察自己。")
                if subject_id in seen_subject_ids:
                    raise CoreRulesError("INVALID_INSPECT_SUBJECTS", "占卜师不能重复选择同一名玩家。")
                seen_subject_ids.add(subject_id)
                self.get_player_or_throw(state, subject_id)
            return

        if role == "slave_trader":
            return

        if role == "grand_official":
            target_id = payload.get("targetPlayerId")
            if not target_id:
                raise CoreRulesError("MISSING_TARGET", "大官必须指定被强制执行技能的玩家。")
            if depth >= 2:
                raise CoreRulesError("FORCE_CHAIN_TOO_DEEP", "强制技能链层级过深。")
            target = self.get_player_or_throw(state, target_id)
            if not target["alive"]:
                raise CoreRulesError("INVALID_TARGET", "被强制执行技能的目标已死亡。")
            self.validate_reveal_payload(
                state,
                target,
                {
                    "targetPlayerId": payload.get("forceSkill", {}).get("targetPlayerId"),
                    "followerIds": payload.get("forceSkill", {}).get("followerIds"),
                    "slaveTraderTargets": payload.get("forceSkill", {}).get("slaveTraderTargets"),
                    "oraclePrediction": payload.get("forceSkill", {}).get("oraclePrediction"),
                    "inspectSubjects": payload.get("forceSkill", {}).get("inspectSubjects"),
                    "forceSkill": payload.get("forceSkill"),
                },
                depth + 1,
            )

    def start_slave_uprising(self, state: dict[str, Any], initiator_player_id: str) -> None:
        initiator = self.get_player_or_throw(state, initiator_player_id)
        add_log(state, "skill", f"{initiator['name']} 发起了起义。", initiator["id"])
        state.setdefault("effects", {}).pop("turnDeadlineAt", None)

        immediate = self.check_win(state)
        if immediate:
            self.apply_win(state, immediate)
            return

        state.setdefault("effects", {})["pendingSlaveUprising"] = {
            "initiatorPlayerId": initiator["id"],
            "stage": "follow",
            "sourcePlayerId": initiator["id"],
            "waitingPlayerIds": [],
            "respondedPlayerIds": [],
            "queue": [],
            "resolvedPlayerIds": [initiator["id"]],
            "deadlineAt": int(time.time() * 1000) + UPRISING_RESPONSE_TIMEOUT_MS,
        }
        self.activate_next_uprising_source(state, initiator["id"], opened_by_player_id=initiator["id"])

    def resolve_slave_uprising_response(
        self,
        state: dict[str, Any],
        responder_player_id: str,
        *,
        join_uprising: bool,
    ) -> None:
        pending = state.get("effects", {}).get("pendingSlaveUprising")
        if not pending or pending.get("stage") != "follow" or responder_player_id not in pending.get("waitingPlayerIds", []):
            raise CoreRulesError("NO_PENDING_FOLLOW", "当前没有等待该玩家响应的起义跟随。")

        source = self.get_player_or_throw(state, pending["sourcePlayerId"])
        responder = self.get_player_or_throw(state, responder_player_id)
        if responder_player_id in pending["respondedPlayerIds"]:
            raise CoreRulesError("FOLLOW_ALREADY_RESOLVED", "你已经对这次起义响应过了。")

        pending["respondedPlayerIds"].append(responder_player_id)
        if responder_player_id not in pending["resolvedPlayerIds"]:
            pending["resolvedPlayerIds"].append(responder_player_id)

        if join_uprising:
            add_log(state, "skill", f"{responder['name']} 跟随了 {source['name']} 发起的起义。", responder["id"], source["id"])
            immediate = self.check_win(state)
            if immediate:
                self.apply_win(state, immediate)
                return
            if responder["id"] not in pending["queue"]:
                pending["queue"].append(responder["id"])
        else:
            add_log(state, "skill", f"{responder['name']} 放弃了跟随 {source['name']} 发起的起义。", responder["id"], source["id"])

        self.advance_pending_slave_uprising_if_needed(state)

    def collect_adjacent_uprising_candidates(
        self,
        state: dict[str, Any],
        source_player_id: str,
        excluded: set[str],
    ) -> list[str]:
        candidates: list[str] = []
        for candidate_id in self.adjacent_players(state, source_player_id):
            if candidate_id in excluded:
                continue
            candidate = state["players"].get(candidate_id)
            if candidate and candidate["alive"] and not candidate["card"]["faceUp"]:
                candidates.append(candidate_id)
        return candidates

    def activate_next_uprising_source(
        self,
        state: dict[str, Any],
        source_player_id: str,
        *,
        opened_by_player_id: str,
    ) -> None:
        pending = state.get("effects", {}).get("pendingSlaveUprising")
        if not pending:
            return

        excluded = set(pending["resolvedPlayerIds"])
        waiting_player_ids = self.collect_adjacent_uprising_candidates(state, source_player_id, excluded)

        if not waiting_player_ids:
            self.advance_pending_slave_uprising_if_needed(state)
            return

        pending["sourcePlayerId"] = source_player_id
        pending["waitingPlayerIds"] = waiting_player_ids
        pending["respondedPlayerIds"] = []
        pending["deadlineAt"] = int(time.time() * 1000) + UPRISING_RESPONSE_TIMEOUT_MS

        source = self.get_player_or_throw(state, source_player_id)
        add_log(state, "skill", f"等待 {source['name']} 两侧玩家选择是否跟随起义。", opened_by_player_id, source["id"])

    def advance_pending_slave_uprising_if_needed(self, state: dict[str, Any]) -> None:
        pending = state.get("effects", {}).get("pendingSlaveUprising")
        if not pending or state.get("winner") or state["phase"] != "in_game":
            return
        if pending.get("waitingPlayerIds") and len(pending.get("respondedPlayerIds", [])) < len(pending["waitingPlayerIds"]):
            return

        pending["waitingPlayerIds"] = []
        pending["respondedPlayerIds"] = []

        while pending["queue"]:
            next_source_id = pending["queue"].pop(0)
            next_source = state["players"].get(next_source_id)
            if not next_source or not next_source["alive"] or not next_source["card"]["faceUp"] or next_source["card"]["role"] != "slave":
                continue
            self.activate_next_uprising_source(state, next_source_id, opened_by_player_id=next_source_id)
            if pending.get("waitingPlayerIds"):
                return

        initiator = self.get_player_or_throw(state, pending["initiatorPlayerId"])
        state["effects"].pop("pendingSlaveUprising", None)
        add_log(state, "turn", f"{initiator['name']} 发起的起义连锁结束，本回合自动结束。", initiator["id"])
        self.finish_action_and_advance(state)

    def handle_timeout(self, state: dict[str, Any]) -> None:
        if state["phase"] != "in_game" or state.get("winner"):
            return

        pending_uprising = state.get("effects", {}).get("pendingSlaveUprising")
        if pending_uprising and pending_uprising.get("stage") == "follow":
            self.resolve_slave_uprising_timeout(state, pending_uprising)
            mark_updated(state)
            return

        pending_oracle = state.get("effects", {}).get("pendingOraclePrediction")
        if pending_oracle:
            actor = self.get_player_or_throw(state, pending_oracle["playerId"])
            state["effects"].pop("pendingOraclePrediction", None)
            add_log(state, "skill", f"{actor['name']} 超时未公开预言，本回合自动结束。", actor["id"])
            self.finish_action_and_advance(state)
            mark_updated(state)
            return

        pending_slave_trader = state.get("effects", {}).get("pendingSlaveTrader")
        if pending_slave_trader:
            actor = self.get_player_or_throw(state, pending_slave_trader["playerId"])
            state["effects"].pop("pendingSlaveTrader", None)
            add_log(state, "skill", f"{actor['name']} 超时未完成奴隶贩子筛查，技能自动结束。", actor["id"])
            self.finish_action_and_advance(state)
            mark_updated(state)
            return

        actor = self.get_player_or_throw(state, self.current_player_id(state))
        add_log(state, "turn", f"{actor['name']} 超时未行动，本回合自动结束。", actor["id"])
        self.finish_action_and_advance(state)
        mark_updated(state)

    def resolve_slave_uprising_timeout(self, state: dict[str, Any], pending_uprising: dict[str, Any]) -> None:
        waiting_ids = [
            player_id
            for player_id in pending_uprising.get("waitingPlayerIds", [])
            if player_id not in pending_uprising.get("respondedPlayerIds", [])
        ]
        for player_id in waiting_ids:
            if state.get("winner"):
                return
            player = self.get_player_or_throw(state, player_id)
            should_follow = (
                player["alive"]
                and player["connected"]
                and not player["card"]["faceUp"]
                and player["card"]["role"] == "slave"
            )
            add_log(
                state,
                "skill",
                f"{player['name']} 超时未响应，系统默认{ '跟随' if should_follow else '放弃' }起义。",
                player["id"],
                pending_uprising["sourcePlayerId"],
            )
            if should_follow:
                self.reveal_player(state, player, pending_uprising["sourcePlayerId"])
            self.resolve_slave_uprising_response(state, player_id, join_uprising=should_follow)

    def trim_knowledge(self, player: dict[str, Any]) -> None:
        knowledge = player.get("privateKnowledge", [])
        if len(knowledge) > 30:
            player["privateKnowledge"] = knowledge[-30:]

    def assert_no_immediate_swap_back(self, state: dict[str, Any], actor_id: str, target_player_id: str) -> None:
        effects = state.get("effects", {})
        protected_player_id = effects.get("noSwapBackA")
        restricted_player_id = effects.get("noSwapBackB")
        restricted_sequence = effects.get("noSwapBackSequence")
        protected_version = effects.get("noSwapBackProtectedVersion")

        if (
            protected_player_id != target_player_id
            or restricted_player_id != actor_id
            or restricted_sequence != state["turn"]["sequence"]
            or protected_version is None
        ):
            return

        protected_player = state["players"].get(protected_player_id)
        if not protected_player:
            return
        if protected_player["card"]["version"] != protected_version:
            return

        raise CoreRulesError("NO_IMMEDIATE_SWAP_BACK", "刚完成交换的两名玩家不能立刻换回去。")

    def get_player_or_throw(self, state: dict[str, Any], player_id: str) -> dict[str, Any]:
        player = state["players"].get(player_id)
        if not player:
            raise CoreRulesError("PLAYER_NOT_FOUND", "玩家不存在。")
        return player

    def next_turn_sequence_for_player(self, state: dict[str, Any], from_player_id: str, to_player_id: str) -> int:
        seat_count = len(state["seatOrder"])
        from_seat = state["players"][from_player_id]["seatIndex"]
        to_seat = state["players"][to_player_id]["seatIndex"]
        distance = (to_seat - from_seat + seat_count) % seat_count
        return state["turn"]["sequence"] + distance

    def current_player_id(self, state: dict[str, Any]) -> str:
        return current_player_id(state)

    def can_sultan_crown_anytime(
        self,
        state: dict[str, Any],
        actor: dict[str, Any],
        payload: dict[str, Any],
    ) -> bool:
        if state["phase"] != "in_game" or state.get("winner"):
            return False
        if actor["card"]["role"] != "sultan":
            return False
        if actor["card"]["faceUp"]:
            return False
        if not actor["alive"]:
            raise CoreRulesError("ACTOR_DEAD", "死亡玩家不能行动。")
        if not actor["connected"]:
            raise CoreRulesError("PLAYER_OFFLINE", "离线玩家不能行动。")
        if state.get("effects", {}).get("pendingSlaveUprising"):
            raise CoreRulesError("PENDING_SLAVE_UPRISING", "当前正在等待奴隶起义的跟随响应。")
        if state.get("effects", {}).get("pendingOraclePrediction"):
            raise CoreRulesError("PENDING_ORACLE_PREDICTION", "当前正在等待占卜师公开预言。")
        if state.get("effects", {}).get("pendingSlaveTrader"):
            raise CoreRulesError("PENDING_SLAVE_TRADER", "当前正在等待奴隶贩子完成筛查。")
        if payload.get("targetPlayerId"):
            raise CoreRulesError("NOT_YOUR_TURN", "苏丹非自己回合只能公开身份，不能处决目标。")
        return True

    def assert_action_turn(self, state: dict[str, Any], actor_id: str) -> None:
        if state["phase"] != "in_game":
            raise CoreRulesError("GAME_NOT_RUNNING", "游戏尚未开始。")
        if state.get("winner"):
            raise CoreRulesError("GAME_FINISHED", "本局已经结束。")
        if state.get("effects", {}).get("pendingSlaveUprising"):
            pending = state["effects"]["pendingSlaveUprising"]
            source = state["players"].get(pending.get("sourcePlayerId"))
            raise CoreRulesError(
                "PENDING_SLAVE_UPRISING",
                f"当前正在等待 {source['name'] if source else '当前登台玩家'} 两侧玩家决定是否跟随起义。",
            )
        if state.get("effects", {}).get("pendingOraclePrediction"):
            oracle_player = state["players"].get(state["effects"]["pendingOraclePrediction"]["playerId"])
            raise CoreRulesError(
                "PENDING_ORACLE_PREDICTION",
                f"当前正在等待 {oracle_player['name'] if oracle_player else '占卜师'} 公开预言。",
            )
        if state.get("effects", {}).get("pendingSlaveTrader"):
            trader_player = state["players"].get(state["effects"]["pendingSlaveTrader"]["playerId"])
            raise CoreRulesError(
                "PENDING_SLAVE_TRADER",
                f"当前正在等待 {trader_player['name'] if trader_player else '奴隶贩子'} 继续筛查。",
            )
        if self.current_player_id(state) != actor_id:
            raise CoreRulesError("NOT_YOUR_TURN", f"还没轮到你行动，当前应由 {self.current_player_id(state)} 行动。")
        actor = self.get_player_or_throw(state, actor_id)
        if not actor["alive"]:
            raise CoreRulesError("ACTOR_DEAD", "死亡玩家不能行动。")
        if actor["skipActions"] > 0:
            raise CoreRulesError("PLAYER_DETAINED", "你已被拘留，暂时不能行动。")
        if not actor["connected"]:
            raise CoreRulesError("PLAYER_OFFLINE", "离线玩家不能行动。")

    def advance_turn(self, state: dict[str, Any]) -> None:
        prev = state["turn"]["currentSeatIndex"]
        next_index = (prev + 1) % len(state["seatOrder"])
        state["turn"]["currentSeatIndex"] = next_index
        state["turn"]["sequence"] += 1
        if next_index == 0:
            state["turn"]["round"] += 1

    def finish_action_and_advance(self, state: dict[str, Any]) -> None:
        if state["phase"] != "in_game":
            return
        if state.get("effects", {}).get("pendingSlaveUprising"):
            return
        if state.get("effects", {}).get("pendingOraclePrediction"):
            return
        if state.get("effects", {}).get("pendingSlaveTrader"):
            return

        immediate = self.check_win(state)
        if immediate:
            self.apply_win(state, immediate)
            return

        self.advance_turn(state)
        self.consume_skipped_turns(state)

        after_turn = self.check_win(state)
        if after_turn:
            self.apply_win(state, after_turn)
            return

        current = state["players"][self.current_player_id(state)]
        add_log(state, "turn", f"第 {state['turn']['round']} 轮，轮到 {current['name']} 行动。")
        state.setdefault("effects", {})["turnDeadlineAt"] = int(time.time() * 1000) + TURN_TIMEOUT_MS

    def consume_skipped_turns(self, state: dict[str, Any]) -> None:
        for _ in range(len(state["seatOrder"])):
            player = state["players"][self.current_player_id(state)]
            if not player["alive"]:
                add_log(state, "turn", f"{player['name']} 已死亡，回合自动跳过。", player["id"])
                self.advance_turn(state)
                continue
            if player["skipActions"] > 0:
                player["skipActions"] -= 1
                add_log(state, "turn", f"{player['name']} 处于拘留状态，本回合被跳过。", player["id"])
                self.advance_turn(state)
                continue
            return

    def check_win(self, state: dict[str, Any]) -> dict[str, Any] | None:
        effects = state.get("effects", {})
        if effects.get("sultanKilledByAssassin"):
            return {
                "winnerFaction": "rebels",
                "reason": "刺客成功刺杀苏丹。",
                "reasonCode": "ASSASSIN_KILL",
            }

        slave_flags = [
            state["players"][player_id]["alive"]
            and state["players"][player_id]["card"]["faceUp"]
            and state["players"][player_id]["card"]["role"] == "slave"
            for player_id in state["seatOrder"]
        ]
        if count_circular_max_run(slave_flags) >= 3:
            return {
                "winnerFaction": "rebels",
                "reason": "三张相邻且公开的奴隶触发起义成功。",
                "reasonCode": "SLAVE_UPRISING",
            }

        sultan_player_id = effects.get("sultanPlayerId")
        crowned_round = effects.get("sultanCrownedRound")
        if sultan_player_id and crowned_round is not None:
            sultan = state["players"].get(sultan_player_id)
            if (
                sultan
                and sultan["alive"]
                and sultan["card"]["faceUp"]
                and sultan["card"]["role"] == "sultan"
                and state["turn"]["round"] > crowned_round
            ):
                return {
                    "winnerFaction": "loyalists",
                    "reason": "苏丹公开后成功存活整整一轮。",
                    "reasonCode": "SULTAN_SURVIVE",
                }
        return None

    def apply_win(self, state: dict[str, Any], win: dict[str, Any]) -> None:
        winners: set[str] = set()
        score_by_player_id = {player_id: 0 for player_id in state["seatOrder"]}

        for player_id in state["seatOrder"]:
            player = state["players"][player_id]
            if player["card"]["role"] == "oracle":
                if player.get("oraclePrediction") == win["winnerFaction"]:
                    winners.add(player["id"])
                    score_by_player_id[player["id"]] = 1
                continue

            if effective_faction(player) == win["winnerFaction"]:
                winners.add(player["id"])
                score_by_player_id[player["id"]] = 1

        if win["reasonCode"] == "SULTAN_SURVIVE" and state.get("effects", {}).get("sultanPlayerId"):
            sultan_id = state["effects"]["sultanPlayerId"]
            score_by_player_id[sultan_id] = 2
            winners.add(sultan_id)

        if win["reasonCode"] == "ASSASSIN_KILL" and state.get("effects", {}).get("assassinKillerPlayerId"):
            assassin_id = state["effects"]["assassinKillerPlayerId"]
            score_by_player_id[assassin_id] = 2
            winners.add(assassin_id)

        for player_id in state["seatOrder"]:
            player = state["players"][player_id]
            if player["card"]["role"] != "grand_official":
                continue
            adjacent = self.adjacent_players(state, player["id"])
            total = sum(score_by_player_id.get(adjacent_id, 0) for adjacent_id in adjacent)
            if total >= 2:
                winners.add(player["id"])
                score_by_player_id[player["id"]] = max(score_by_player_id[player["id"]], 1)
                add_log(state, "skill", f"{player['name']} 的大官附加胜利条件达成（相邻得分 {total}）。", player["id"])

        state["winner"] = {
            "winnerFaction": win["winnerFaction"],
            "winners": [player_id for player_id in state["seatOrder"] if player_id in winners],
            "reason": win["reason"],
            "scoreByPlayerId": score_by_player_id,
            "endedAt": int(time.time() * 1000),
        }
        state.setdefault("effects", {}).pop("turnDeadlineAt", None)
        state.setdefault("effects", {}).pop("pendingSlaveUprising", None)
        state.setdefault("effects", {}).pop("pendingOraclePrediction", None)
        state.setdefault("effects", {}).pop("pendingSlaveTrader", None)
        state["phase"] = "finished"
        add_log(state, "win", f"{faction_name_zh(win['winnerFaction'])}获胜：{win['reason']}")

    def are_adjacent(self, state: dict[str, Any], left_id: str, right_id: str) -> bool:
        left_seat = state["players"].get(left_id, {}).get("seatIndex")
        right_seat = state["players"].get(right_id, {}).get("seatIndex")
        if left_seat is None or right_seat is None:
            return False
        left, right = circular_adjacent_seat_indices(left_seat, len(state["seatOrder"]))
        return left == right_seat or right == right_seat

    def adjacent_players(self, state: dict[str, Any], player_id: str) -> list[str]:
        seat = state["players"].get(player_id, {}).get("seatIndex")
        if seat is None:
            return []
        left, right = circular_adjacent_seat_indices(seat, len(state["seatOrder"]))
        return [state["seatOrder"][left], state["seatOrder"][right]]

    def is_guard_charmed(self, state: dict[str, Any], guard_player_id: str) -> bool:
        return any(
            state["players"].get(player_id)
            and state["players"][player_id]["alive"]
            and state["players"][player_id]["card"]["faceUp"]
            and state["players"][player_id]["card"]["role"] == "belly_dancer"
            for player_id in self.adjacent_players(state, guard_player_id)
        )

    def find_protecting_guards(self, state: dict[str, Any], assassin_id: str, target_id: str) -> list[str]:
        candidates = set(self.adjacent_players(state, assassin_id) + self.adjacent_players(state, target_id))
        guards: list[str] = []
        for player_id in candidates:
            player = state["players"].get(player_id)
            if not player or not player["alive"]:
                continue
            if player["card"]["role"] != "guard":
                continue
            if self.is_guard_charmed(state, player["id"]):
                continue
            guards.append(player["id"])
        return guards

    def pick_default_oracle_subjects(self, state: dict[str, Any], oracle_id: str) -> list[dict[str, Any]]:
        pool: list[dict[str, Any]] = [
            {"subjectType": "player", "subjectId": player_id}
            for player_id in state["seatOrder"]
            if player_id != oracle_id
        ]
        pool.append({"subjectType": "center", "subjectId": "center"})
        random.shuffle(pool)
        return pool[:3]
