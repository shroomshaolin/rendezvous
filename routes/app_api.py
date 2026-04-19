from fastapi.responses import JSONResponse
from pathlib import Path
import importlib.util
import json
import asyncio
import uuid
from datetime import datetime, timezone


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TOOL_PATH = PLUGIN_ROOT / "tools" / "rendezvous.py"
DATA_DIR = PLUGIN_ROOT / "data"
HISTORY_FILE = DATA_DIR / "history.json"

_RENDEZVOUS_TOOL = None


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_tool_module_fresh():
    spec = importlib.util.spec_from_file_location("rendezvous_tool_runtime", TOOL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load tool module from {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _get_tool_module():
    global _RENDEZVOUS_TOOL
    if _RENDEZVOUS_TOOL is None:
        _RENDEZVOUS_TOOL = _load_tool_module_fresh()
    return _RENDEZVOUS_TOOL


def _load_json(path):
    path = Path(path)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _merged_personas():
    core = _load_json("/app/core/personas/personas.json")
    user = _load_json("/app/user/personas/personas.json")

    if not isinstance(core, dict):
        core = {}
    if not isinstance(user, dict):
        user = {}

    core.pop("_comment", None)
    user.pop("_comment", None)

    merged = dict(core)
    merged.update(user)
    return merged


def _persona_list():
    personas = _merged_personas()
    items = []

    for key, value in personas.items():
        if key.startswith("_"):
            continue
        if not isinstance(value, dict):
            continue

        items.append({
            "key": key,
            "name": value.get("name", key),
            "tagline": value.get("tagline", ""),
            "avatar": value.get("avatar"),
            "trim_color": (value.get("settings", {}) or {}).get("trim_color", ""),
        })

    items.sort(key=lambda x: x["key"].lower())
    return items


def _tool_state():
    try:
        tool = _get_tool_module()
    except Exception as e:
        return {
            "active": False,
            "persona_1": "",
            "persona_2": "",
            "scene": "",
            "messages_per_batch": 4,
            "next_speaker": "",
            "turn_count": 0,
            "transcript": [],
            "transcript_text": f"Tool load error: {e}",
        }

    state = getattr(tool, "STATE", {}) or {}

    transcript_text = ""
    formatter = getattr(tool, "_format_transcript", None)
    if callable(formatter):
        try:
            transcript_text = formatter()
        except Exception as e:
            transcript_text = f"Transcript format error: {e}"

    return {
        "active": bool(state.get("active", False)),
        "persona_1": state.get("persona_1", ""),
        "persona_2": state.get("persona_2", ""),
        "scene": state.get("scene", ""),
        "messages_per_batch": state.get("messages_per_batch", 4),
        "next_speaker": state.get("next_speaker", ""),
        "turn_count": state.get("turn_count", 0),
        "transcript": state.get("transcript", []),
        "transcript_text": transcript_text,
    }


def _call_tool(arguments):
    tool = _get_tool_module()
    result, ok = tool.execute(
        "rendezvous",
        arguments,
        config={},
        plugin_settings={}
    )
    return result, ok


async def _call_tool_async(arguments):
    return await asyncio.to_thread(_call_tool, arguments)


def _to_int(value, default):
    try:
        return int(value)
    except Exception:
        return default


async def _get_payload(body=None, request=None):
    if isinstance(body, dict):
        return body
    if request is not None:
        try:
            return await request.json()
        except Exception:
            return {}
    return {}


def _load_history_entries():
    _ensure_data_dir()
    if not HISTORY_FILE.exists():
        return []

    try:
        data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except Exception:
        pass

    return []


def _save_history_entries(entries):
    _ensure_data_dir()
    HISTORY_FILE.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def _history_summary(entry):
    return {
        "id": entry.get("id", ""),
        "title": entry.get("title", ""),
        "created_at": entry.get("created_at", ""),
        "persona_1": entry.get("persona_1", ""),
        "persona_2": entry.get("persona_2", ""),
        "scene": entry.get("scene", ""),
        "turn_count": entry.get("turn_count", 0),
    }


def _history_summaries(entries):
    return [_history_summary(x) for x in entries]


def _current_session_archive(label=""):
    state = _tool_state()
    transcript_text = str(state.get("transcript_text", "")).strip()

    if not transcript_text:
        return None

    persona_1 = state.get("persona_1", "") or ""
    persona_2 = state.get("persona_2", "") or ""
    scene = state.get("scene", "") or ""
    title = label.strip() or f"{persona_1 or 'Unknown'} ↔ {persona_2 or 'Unknown'}"

    return {
        "id": uuid.uuid4().hex[:12],
        "title": title,
        "created_at": _utc_now(),
        "persona_1": persona_1,
        "persona_2": persona_2,
        "scene": scene,
        "messages_per_batch": state.get("messages_per_batch", 0),
        "turn_count": state.get("turn_count", 0),
        "transcript": state.get("transcript", []),
        "transcript_text": transcript_text,
    }


async def get_personas(request=None, body=None, **kwargs):
    return JSONResponse({
        "ok": True,
        "personas": _persona_list()
    })


async def get_state(request=None, body=None, **kwargs):
    return JSONResponse({
        "ok": True,
        "state": _tool_state()
    })


async def start_session(request=None, body=None, **kwargs):
    payload = await _get_payload(body=body, request=request)

    persona_1 = str(payload.get("persona_1", "")).strip()
    persona_2 = str(payload.get("persona_2", "")).strip()
    scene = str(payload.get("scene", "")).strip()

    turns_each = _to_int(payload.get("turns_each", 2), 2)
    if turns_each < 1:
        turns_each = 1

    messages_per_batch = _to_int(payload.get("messages_per_batch", turns_each * 2), turns_each * 2)
    if messages_per_batch < 2:
        messages_per_batch = 2

    result, ok = await _call_tool_async({
        "action": "start",
        "persona_1": persona_1,
        "persona_2": persona_2,
        "scene": scene,
        "messages_per_batch": messages_per_batch,
    })

    if not ok:
        return JSONResponse({"ok": False, "error": str(result)}, status_code=400)

    return JSONResponse({
        "ok": True,
        "status": "paused",
        "transcript": str(result),
        "state": _tool_state()
    })


async def continue_session(request=None, body=None, **kwargs):
    result, ok = await _call_tool_async({
        "action": "continue"
    })

    if not ok:
        return JSONResponse({"ok": False, "error": str(result)}, status_code=400)

    return JSONResponse({
        "ok": True,
        "status": "paused",
        "transcript": str(result),
        "state": _tool_state()
    })


async def user_message(request=None, body=None, **kwargs):
    payload = await _get_payload(body=body, request=request)

    user_message = str(payload.get("user_message", "")).strip()
    if not user_message:
        return JSONResponse({"ok": False, "error": "user_message is required"}, status_code=400)

    result, ok = await _call_tool_async({
        "action": "user_message",
        "user_message": user_message
    })

    if not ok:
        return JSONResponse({"ok": False, "error": str(result)}, status_code=400)

    return JSONResponse({
        "ok": True,
        "status": "paused",
        "transcript": str(result),
        "state": _tool_state()
    })


async def end_session(request=None, body=None, **kwargs):
    result, ok = await _call_tool_async({
        "action": "end"
    })

    if not ok:
        return JSONResponse({"ok": False, "error": str(result)}, status_code=400)

    return JSONResponse({
        "ok": True,
        "status": "ended",
        "transcript": str(result),
        "state": _tool_state()
    })


async def get_history(request=None, body=None, **kwargs):
    entries = _load_history_entries()
    return JSONResponse({
        "ok": True,
        "history": _history_summaries(entries)
    })


async def save_history(request=None, body=None, **kwargs):
    payload = await _get_payload(body=body, request=request)
    label = str(payload.get("label", "")).strip()

    entry = _current_session_archive(label=label)
    if not entry:
        return JSONResponse({"ok": False, "error": "Nothing to archive"}, status_code=400)

    entries = _load_history_entries()
    entries.insert(0, entry)
    entries = entries[:100]
    _save_history_entries(entries)

    return JSONResponse({
        "ok": True,
        "saved": _history_summary(entry),
        "history": _history_summaries(entries)
    })


async def load_history(request=None, body=None, **kwargs):
    payload = await _get_payload(body=body, request=request)
    entry_id = str(payload.get("id", "")).strip()

    entries = _load_history_entries()
    for entry in entries:
        if entry.get("id") == entry_id:
            return JSONResponse({
                "ok": True,
                "entry": entry
            })

    return JSONResponse({"ok": False, "error": "Archive entry not found"}, status_code=404)


async def delete_history(request=None, body=None, **kwargs):
    payload = await _get_payload(body=body, request=request)
    entry_id = str(payload.get("id", "")).strip()

    entries = _load_history_entries()
    new_entries = [e for e in entries if e.get("id") != entry_id]

    if len(new_entries) == len(entries):
        return JSONResponse({"ok": False, "error": "Archive entry not found"}, status_code=404)

    _save_history_entries(new_entries)

    return JSONResponse({
        "ok": True,
        "history": _history_summaries(new_entries)
    })
