from __future__ import annotations

import json
import sys
import traceback

from engine import CoreRulesEngine
from errors import CoreRulesError

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def main() -> int:
    raw = sys.stdin.read()
    request = json.loads(raw or "{}")
    engine = CoreRulesEngine()

    try:
        data = engine.dispatch(request.get("command", ""), request)
        sys.stdout.write(json.dumps({"ok": True, "data": data}))
        return 0
    except CoreRulesError as error:
        sys.stdout.write(json.dumps({"ok": False, "error": error.to_dict()}))
        return 0
    except Exception as error:  # pragma: no cover - crash safety
        sys.stdout.write(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": str(error) or "未知错误",
                    },
                }
            )
        )
        sys.stderr.write(traceback.format_exc())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
