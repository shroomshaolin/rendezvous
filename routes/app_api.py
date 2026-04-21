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
TRANSCRIPTS_DIR = Path("/app/user/rendezvous_data/transcripts")

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
    _ = str(payload.get("label", "")).strip()  # ignored; transcript files use tool naming

    tool = _get_tool_module()
    archiver = getattr(tool, "_archive_transcript", None)

    if not callable(archiver):
        return JSONResponse({"ok": False, "error": "Archive creation unavailable"}, status_code=500)

    filename = archiver()
    if not filename:
        return JSONResponse({"ok": False, "error": "Nothing to archive"}, status_code=400)

    items = tool._list_archived_transcripts() if hasattr(tool, "_list_archived_transcripts") else []

    return JSONResponse({
        "ok": True,
        "filename": filename,
        "transcripts": items
    })

async def load_history(request=None, body=None, **kwargs):
    payload = await _get_payload(body=body, request=request)

    entry_id = str(payload.get("id", "")).strip()
    filename = str(payload.get("filename", "")).strip()
    session_id = str(payload.get("session_id", "")).strip()
    index_raw = str(payload.get("index", "")).strip()

    tool = _get_tool_module()

    def _resume_from_entry(entry):
        transcript = list(entry.get("transcript") or [])
        persona_1 = str(entry.get("persona_1", "") or "")
        persona_2 = str(entry.get("persona_2", "") or "")
        speakers = list(entry.get("speakers") or [])
        if not persona_1 and len(speakers) > 0:
            persona_1 = str(speakers[0]).strip()
        if not persona_2 and len(speakers) > 1:
            persona_2 = str(speakers[1]).strip()
        scene = str(entry.get("scene", "") or "")
        messages_per_batch = int(entry.get("messages_per_batch", 4) or 4)
        turn_count = int(entry.get("turn_count", 0) or 0)

        next_speaker = persona_1
        if transcript:
            last = transcript[-1]
            last_speaker = ""
            if isinstance(last, dict):
                for key in ("speaker", "name", "persona", "role"):
                    value = last.get(key)
                    if isinstance(value, str) and value.strip():
                        last_speaker = value.strip()
                        break

            if last_speaker == persona_1 and persona_2:
                next_speaker = persona_2
            elif last_speaker == persona_2 and persona_1:
                next_speaker = persona_1

        tool.STATE["active"] = True
        tool.STATE["persona_1"] = persona_1
        tool.STATE["persona_2"] = persona_2
        tool.STATE["chat_1"] = persona_1
        tool.STATE["chat_2"] = persona_2
        tool.STATE["scene"] = scene
        tool.STATE["messages_per_batch"] = messages_per_batch
        tool.STATE["turn_count"] = turn_count
        tool.STATE["transcript"] = transcript
        tool.STATE["history"] = list(transcript)
        tool.STATE["next_speaker"] = next_speaker

        transcript_text = entry.get("transcript_text", "")
        formatter = getattr(tool, "_format_transcript", None)
        if callable(formatter):
            try:
                transcript_text = formatter()
            except Exception:
                transcript_text = entry.get("transcript_text", "")

        tool.STATE["transcript_text"] = transcript_text

        hydrated_entry = dict(entry)
        hydrated_entry["transcript_text"] = transcript_text

        return JSONResponse({
            "ok": True,
            "entry": hydrated_entry,
            "resumed": True
        })


    def _entry_from_archive_payload(data, fallback_name=""):
        if not isinstance(data, dict):
            return None

        participants = data.get("participants") or data.get("speakers") or []
        p1 = str(data.get("persona_1") or (participants[0] if len(participants) > 0 else "") or "")
        p2 = str(data.get("persona_2") or (participants[1] if len(participants) > 1 else "") or "")
        transcript = data.get("transcript") or data.get("messages") or []

        return {
            "id": str(data.get("id") or Path(str(fallback_name or "archive")).stem),
            "title": str(data.get("title") or f"{p1 or 'Unknown'} ↔ {p2 or 'Unknown'}"),
            "created_at": str(data.get("created_at") or data.get("saved_at") or ""),
            "persona_1": p1,
            "persona_2": p2,
            "speakers": participants,
            "scene": str(data.get("scene") or ""),
            "messages_per_batch": int(data.get("messages_per_batch", 4) or 4),
            "turn_count": int(data.get("turn_count", 0) or 0),
            "transcript": transcript if isinstance(transcript, list) else [],
            "transcript_text": str(data.get("transcript_text") or ""),
        }

    archive_reader = getattr(tool, "_read_archived_transcript", None)
    archive_by_index = getattr(tool, "_archived_transcript_by_index", None)
    archive_list = getattr(tool, "_list_archived_transcripts", None)

    # Fast path: load directly by filename from the tool helper.
    if filename and callable(archive_reader):
        direct = archive_reader(filename)
        entry = _entry_from_archive_payload(direct, fallback_name=filename)
        if entry is not None:
            return _resume_from_entry(entry)

    # Fast path: load directly by visible archive index.
    if index_raw != "" and callable(archive_by_index):
        direct = archive_by_index(index_raw)
        entry = _entry_from_archive_payload(direct, fallback_name=f"archive_{index_raw}")
        if entry is not None:
            return _resume_from_entry(entry)

    # Fast path: map session_id -> filename -> archive helper.
    if session_id and callable(archive_list) and callable(archive_reader):
        try:
            items = archive_list() or []
        except Exception:
            items = []

        for item in items:
            item_session_id = str(item.get("session_id", "") or item.get("id", "") or "")
            item_filename = str(item.get("filename", "") or "")
            if item_session_id and item_session_id == session_id and item_filename:
                direct = archive_reader(item_filename)
                entry = _entry_from_archive_payload(direct, fallback_name=item_filename)
                if entry is not None:
                    return _resume_from_entry(entry)


    # 1) Legacy history.json resume by id
    entries = _load_history_entries()
    if entry_id:
        for entry in entries:
            if entry.get("id") == entry_id:
                return _resume_from_entry(entry)

    # 2) Transcript-file resume by filename / session_id / index
    items = tool._list_archived_transcripts() if hasattr(tool, "_list_archived_transcripts") else []

    selected = None

    if index_raw != "":
        idx = _to_int(index_raw, -1)
        if 0 <= idx < len(items):
            selected = items[idx]

    if selected is None:
        for item in items:
            item_filename = str(item.get("filename", "") or "")
            item_session_id = str(item.get("session_id", "") or item.get("id", "") or "")
            if filename and item_filename == filename:
                selected = item
                break
            if session_id and item_session_id == session_id:
                selected = item
                break

    candidate_dirs = []
    seen = set()

    def add_dir(path_str):
        if not path_str:
            return
        try:
            d = Path(path_str)
        except Exception:
            return
        key = str(d)
        if key not in seen:
            seen.add(key)
            candidate_dirs.append(d)

    add_dir("/app/user/rendezvous_data/transcripts")
    add_dir("/app/user/plugins/rendezvous/data/transcripts")
    add_dir("/app/user/plugins/rendezvous/data/archives")
    add_dir(getattr(tool, "TRANSCRIPTS_DIR", ""))
    add_dir(getattr(tool, "TRANSCRIPT_DIR", ""))
    add_dir(getattr(tool, "ARCHIVE_DIR", ""))

    names_to_try = []

    def push_name(name):
        name = str(name or "").strip()
        if name and name not in names_to_try:
            names_to_try.append(name)

    if selected is not None:
        push_name(selected.get("filename", ""))
        push_name(selected.get("session_id", ""))
        push_name(selected.get("id", ""))

    push_name(filename)
    push_name(session_id)

    target = None
    for d in candidate_dirs:
        if not d.exists():
            continue
        for name in names_to_try:
            direct = d / name
            if direct.exists() and direct.is_file():
                target = direct
                break
            if "." not in name:
                for ext in (".json", ".txt", ".md"):
                    probe = d / f"{name}{ext}"
                    if probe.exists() and probe.is_file():
                        target = probe
                        break
            if target is not None:
                break
        if target is not None:
            break

    if target is not None:
        try:
            raw = target.read_text(encoding="utf-8")
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"Failed to read archive: {e}"}, status_code=500)

        entry = None

        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                participants = data.get("participants") or []
                p1 = str(data.get("persona_1") or (participants[0] if len(participants) > 0 else "") or "")
                p2 = str(data.get("persona_2") or (participants[1] if len(participants) > 1 else "") or "")
                transcript = data.get("transcript") or data.get("messages") or []

                entry = {
                    "id": str(data.get("id") or target.stem),
                    "title": str(data.get("title") or f"{p1 or 'Unknown'} ↔ {p2 or 'Unknown'}"),
                    "created_at": str(data.get("created_at") or data.get("saved_at") or ""),
                    "persona_1": p1,
                    "persona_2": p2,
                    "scene": str(data.get("scene") or ""),
                    "messages_per_batch": int(data.get("messages_per_batch", 4) or 4),
                    "turn_count": int(data.get("turn_count", 0) or 0),
                    "transcript": transcript if isinstance(transcript, list) else [],
                    "transcript_text": str(data.get("transcript_text") or ""),
                }
        except Exception:
            entry = None

        if entry is not None:
            return _resume_from_entry(entry)

        return JSONResponse({
            "ok": False,
            "error": f"Archive file found but could not be resumed: {target.name}"
        }, status_code=400)

    return JSONResponse({
        "ok": False,
        "error": f"Archive entry not found | id={entry_id!r} | filename={filename!r} | session_id={session_id!r} | index={index_raw!r} | items={len(items)}"
    }, status_code=404)
async def delete_history(request=None, body=None, **kwargs):
    payload = await _get_payload(body=body, request=request)

    filename = str(payload.get("filename", "")).strip()
    session_id = str(payload.get("session_id", "")).strip()
    index_raw = str(payload.get("index", "")).strip()

    tool = _get_tool_module()
    items = tool._list_archived_transcripts() if hasattr(tool, "_list_archived_transcripts") else []

    # Build a list of candidate transcript directories to search.
    candidate_dirs = []
    seen = set()

    def add_dir(path_str):
        try:
            d = Path(path_str)
        except Exception:
            return
        key = str(d)
        if key not in seen:
            seen.add(key)
            candidate_dirs.append(d)

    add_dir("/app/user/rendezvous_data/transcripts")
    add_dir("/app/user/plugins/rendezvous/data/transcripts")

    for base in (Path("/app/user/plugins"), Path("/app/user/plugin-saves")):
        if base.exists():
            for d in base.glob("rendezvous*/data/transcripts"):
                add_dir(str(d))

    target = None

    # 1) Prefer row index from the current transcript list.
    if index_raw:
        try:
            idx = int(index_raw)
        except Exception:
            idx = -1

        if 0 <= idx < len(items):
            fname = str(items[idx].get("filename", "")).strip()
            if fname:
                filename = fname

    # 2) Delete by filename across every known transcript store.
    if filename:
        safe = Path(filename).name
        for d in candidate_dirs:
            candidate = d / safe
            if candidate.exists() and candidate.is_file():
                target = candidate
                break

    # 3) Fallback: match by session_id across every known transcript store.
    if target is None and session_id:
        for d in candidate_dirs:
            if not d.exists():
                continue
            for candidate in sorted(d.glob("*.json"), reverse=True):
                try:
                    payload2 = json.loads(candidate.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if str(payload2.get("session_id", "")).strip() == session_id:
                    target = candidate
                    break
            if target is not None:
                break

    # 4) If we found a transcript file, delete it and refresh transcript list.
    if target is not None:
        try:
            target.unlink()
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"Delete failed: {e}"}, status_code=500)

        items = tool._list_archived_transcripts() if hasattr(tool, "_list_archived_transcripts") else []
        return JSONResponse({
            "ok": True,
            "transcripts": items
        })

    # 5) Legacy history.json delete path, only if no transcript identifier was given.
    if not filename and not session_id and not index_raw:
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

    return JSONResponse({
        "ok": False,
        "error": f"Archive entry not found | filename={filename!r} | session_id={session_id!r} | index={index_raw!r} | items={len(items)}"
    }, status_code=404)


async def delete_transcript_http(request=None, body=None, settings=None, **kwargs):
    filename = ""

    if request is not None:
        try:
            filename = str(request.query_params.get("filename", "")).strip()
        except Exception:
            filename = ""

    if not filename and isinstance(body, dict):
        filename = str(body.get("filename", "")).strip()

    return await delete_history(body={"filename": filename})
    
def list_transcripts(request=None, body=None, settings=None, **kwargs):
    tool = _get_tool_module()
    if hasattr(tool, "_list_archived_transcripts"):
        return {"ok": True, "transcripts": tool._list_archived_transcripts()}
    return {"ok": True, "transcripts": []}

