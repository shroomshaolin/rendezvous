from pathlib import Path
import json
import re
import uuid

import requests
import urllib3

ENABLED = True
EMOJI = "☕"
AVAILABLE_FUNCTIONS = ["rendezvous"]

TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "rendezvous",
            "description": "Run a two-person freeform rendezvous between any two Sapphire personas in bounded batches.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "One of: start, continue, user_message, end"
                    },
                    "persona_1": {
                        "type": "string",
                        "description": "First persona name"
                    },
                    "persona_2": {
                        "type": "string",
                        "description": "Second persona name"
                    },
                    "scene": {
                        "type": "string",
                        "description": "Optional scene seed"
                    },
                    "user_message": {
                        "type": "string",
                        "description": "Optional message from the user"
                    },
                    "messages_per_batch": {
                        "type": "integer",
                        "description": "How many total persona messages before pausing"
                    }
                },
                "required": ["action"]
            }
        }
    }
]

SETTINGS = {
    "RENDEZVOUS_DEFAULT_BATCH": 10,
    "RENDEZVOUS_MAX_BATCH": 20,
    "RENDEZVOUS_USER_NAME": "You"
}

SETTINGS_HELP = {
    "RENDEZVOUS_DEFAULT_BATCH": "Default total number of persona messages before pausing.",
    "RENDEZVOUS_MAX_BATCH": "Maximum total number of persona messages before pausing.",
    "RENDEZVOUS_USER_NAME": "Label shown when the user speaks in the transcript."
}

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_URL = "https://127.0.0.1:8073"

STATE = {
    "active": False,
    "persona_1": "",
    "persona_2": "",
    "scene": "",
    "messages_per_batch": 10,
    "transcript": [],
    "next_speaker": "",
    "turn_count": 0,
    "chat_1": "",
    "chat_2": ""
}


def _clean_text(value):
    return str(value).strip()


def _to_int(value, default):
    try:
        return int(value)
    except Exception:
        return default


def _slug(value):
    s = re.sub(r"[^a-zA-Z0-9_-]+", "-", _clean_text(value)).strip("-").lower()
    return s or "chat"


def _read_api_key():
    candidates = [
        Path("/home/sapphire/.config/sapphire/secret_key"),
        Path.home() / ".config" / "sapphire" / "secret_key",
        Path.home() / "Library" / "Application Support" / "Sapphire" / "secret_key",
    ]
    for path in candidates:
        if path.exists():
            text = path.read_text(encoding="utf-8").strip()
            if text:
                return text
    raise RuntimeError("Could not find Sapphire secret_key")


def _api(method, path, payload=None):
    headers = {"X-API-Key": _read_api_key()}
    url = f"{BASE_URL}{path}"

    resp = requests.request(
        method=method,
        url=url,
        headers=headers,
        json=payload,
        timeout=180,
        verify=False,
    )

    if resp.status_code >= 400:
        raise RuntimeError(f"{method} {path} failed: {resp.status_code} {resp.text[:400]}")

    content_type = (resp.headers.get("content-type") or "").lower()
    if "application/json" in content_type:
        return resp.json()

    text = resp.text.strip()
    try:
        return resp.json()
    except Exception:
        return text


def _looks_like_prompt_scaffold(text):
    if not isinstance(text, str):
        return False

    markers = (
        "Persona metadata:",
        "Other persona hints:",
        "Scene seed:",
        "Transcript so far:",
        "Write exactly ONE natural next message as yourself only.",
        "Do not write the speaker name.",
        "Do not speak for the other persona.",
        "Do not summarize.",
        "Do not explain your reasoning.",
        "Do not call tools.",
        "Keep it conversational and organic.",
    )
    return any(marker in text for marker in markers)


def _sanitize_reply_text(text):
    if not isinstance(text, str):
        return ""

    text = text.strip()
    if not text:
        return ""

    # If a debug-style transcript leaked, keep only the last Avatar chunk.
    lines = text.splitlines()
    chunks = []
    current = []
    saw_avatar = False

    for line in lines:
        if line.strip() == "Avatar":
            saw_avatar = True
            chunk = "
".join(current).strip()
            if chunk:
                chunks.append(chunk)
            current = []
            continue
        current.append(line)

    chunk = "
".join(current).strip()
    if chunk:
        chunks.append(chunk)

    if saw_avatar and chunks:
        text = chunks[-1]

    cleaned = []
    icon_only = {"🗑️", "🔄", "▶️", "✏️", "🔊", "🎤", "📎"}

    for line in text.splitlines():
        stripped = line.strip()

        if not stripped:
            cleaned.append("")
            continue

        if stripped in icon_only:
            continue

        if stripped == "Avatar":
            continue

        if "tok/s" in stripped and " in / " in stripped:
            continue

        if _looks_like_prompt_scaffold(stripped):
            continue

        cleaned.append(line)

    text = "
".join(cleaned).strip()

    if _looks_like_prompt_scaffold(text):
        return ""

    return text


def _extract_reply_text(payload):
    if isinstance(payload, str):
        return _sanitize_reply_text(payload)

    if isinstance(payload, list):
        for item in payload:
            text = _extract_reply_text(item)
            if text:
                return text
        return ""

    if isinstance(payload, dict):
        preferred_keys = (
            "response",
            "assistant",
            "reply",
            "output",
            "content",
        )
        fallback_keys = (
            "text",
            "message",
            "input",
            "prompt",
        )

        for key in preferred_keys + fallback_keys:
            if key not in payload:
                continue
            text = _extract_reply_text(payload.get(key))
            if text:
                return text

        for key, value in payload.items():
            if key in preferred_keys or key in fallback_keys:
                continue
            text = _extract_reply_text(value)
            if text:
                return text

    return ""

def _strip_speaker_prefix(text, speaker):
    text = (text or "").strip()

    patterns = [
        rf"^{re.escape(speaker)}\s*:\s*",
        r"^[A-Za-z0-9 _-]+\s*:\s*"
    ]

    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE).strip()

    return text.strip().strip('"').strip()


def _load_json(path):
    path = Path(path)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _deep_merge(a, b):
    if not isinstance(a, dict):
        a = {}
    if not isinstance(b, dict):
        b = {}

    out = dict(a)
    for k, v in b.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _root_paths():
    return {
        "core_personas": "/app/core/personas/personas.json",
        "user_personas": "/app/user/personas/personas.json",
        "core_monoliths": "/app/core/prompt_defaults/prompt_monoliths.json",
        "user_monoliths": "/app/user/prompts/prompt_monoliths.json",
        "core_pieces": "/app/core/prompt_defaults/prompt_pieces.json",
        "user_pieces": "/app/user/prompts/prompt_pieces.json",
    }


def _merged_personas():
    p = _root_paths()
    core = _load_json(p["core_personas"])
    user = _load_json(p["user_personas"])
    core.pop("_comment", None)
    user.pop("_comment", None)
    return _deep_merge(core, user)


def _merged_monoliths():
    p = _root_paths()
    core = _load_json(p["core_monoliths"])
    user = _load_json(p["user_monoliths"])
    core.pop("_comment", None)
    user.pop("_comment", None)
    return _deep_merge(core, user)


def _merged_pieces():
    p = _root_paths()
    core = _load_json(p["core_pieces"])
    user = _load_json(p["user_pieces"])
    core.pop("_comment", None)
    user.pop("_comment", None)
    return _deep_merge(core, user)


def _prompt_value_to_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("content", "")).strip()
    return ""


def _resolve_prompt_text(prompt_name, ai_name, user_name):
    prompt_name = _clean_text(prompt_name)
    if not prompt_name:
        return ""

    monoliths = _merged_monoliths()
    value = monoliths.get(prompt_name)
    text = _prompt_value_to_text(value)

    if not text:
        pieces = _merged_pieces()
        components = pieces.get("components", {})

        for section_name in ("character", "persona"):
            section = components.get(section_name, {})
            if not isinstance(section, dict):
                continue

            text = (
                section.get(prompt_name)
                or section.get(prompt_name.lower())
                or section.get(prompt_name.upper())
                or ""
            )
            if text:
                break

    if not text:
        return ""

    return (
        text.replace("{ai_name}", ai_name)
            .replace("{user_name}", user_name)
    ).strip()


def _load_persona_bundle(persona_name, user_name):
    persona_key = _clean_text(persona_name).lower()
    personas = _merged_personas()

    if persona_key not in personas:
        raise ValueError(f"Unknown persona: {persona_name}")

    raw = personas[persona_key] or {}
    settings = raw.get("settings", {}) or {}

    ai_name = raw.get("name") or persona_name
    prompt_name = settings.get("prompt", "")
    prompt_text = _resolve_prompt_text(prompt_name, ai_name=ai_name, user_name=user_name)

    return {
        "key": persona_key,
        "name": ai_name,
        "tagline": raw.get("tagline", ""),
        "avatar": raw.get("avatar"),
        "avatar_full": raw.get("avatar_full"),
        "prompt_name": prompt_name,
        "prompt_text": prompt_text,
        "custom_context": settings.get("custom_context", ""),
        "toolset": settings.get("toolset", ""),
        "spice_set": settings.get("spice_set", ""),
        "spice_enabled": settings.get("spice_enabled", False),
        "spice_turns": settings.get("spice_turns", 0),
        "voice": settings.get("voice", ""),
        "pitch": settings.get("pitch"),
        "speed": settings.get("speed"),
        "llm_primary": settings.get("llm_primary", ""),
        "llm_model": settings.get("llm_model", ""),
        "memory_scope": settings.get("memory_scope", ""),
        "goal_scope": settings.get("goal_scope", ""),
        "knowledge_scope": settings.get("knowledge_scope", ""),
        "people_scope": settings.get("people_scope", ""),
        "story_engine_enabled": settings.get("story_engine_enabled", False),
        "story_preset": settings.get("story_preset"),
        "story_vars_in_prompt": settings.get("story_vars_in_prompt", False),
        "story_in_prompt": settings.get("story_in_prompt", False),
        "raw": raw,
    }


def _build_identity_block(bundle):
    parts = []

    if bundle["prompt_text"]:
        parts.append(bundle["prompt_text"])

    if bundle["tagline"]:
        parts.append(f"Tagline: {bundle['tagline']}")

    if bundle["custom_context"]:
        parts.append(bundle["custom_context"])

    metadata = [
        f"name={bundle['name']}",
        f"prompt_name={bundle['prompt_name']}",
        f"toolset={bundle['toolset']}",
        f"voice={bundle['voice']}",
        f"llm_primary={bundle['llm_primary']}",
        f"llm_model={bundle['llm_model']}",
        f"memory_scope={bundle['memory_scope']}",
        f"goal_scope={bundle['goal_scope']}",
        f"knowledge_scope={bundle['knowledge_scope']}",
        f"people_scope={bundle['people_scope']}",
        f"spice_set={bundle['spice_set']}",
        f"spice_enabled={bundle['spice_enabled']}",
        f"spice_turns={bundle['spice_turns']}",
        f"story_engine_enabled={bundle['story_engine_enabled']}",
        f"story_in_prompt={bundle['story_in_prompt']}",
        f"story_vars_in_prompt={bundle['story_vars_in_prompt']}",
    ]
    parts.append("Persona metadata: " + "; ".join(metadata))

    return "\n\n".join(part for part in parts if str(part).strip())


def _create_chat(name):
    attempts = [
        {"name": name},
        {"chat_name": name},
        {"title": name},
    ]

    last_error = None
    for body in attempts:
        try:
            return _api("POST", "/api/chats", body)
        except Exception as e:
            last_error = e

    raise RuntimeError(f"Could not create chat '{name}': {last_error}")


def _delete_chat(name):
    try:
        _api("DELETE", f"/api/chats/{name}")
    except Exception:
        pass


def _chat_once(prompt, chat_name):
    attempts = [
        {"text": prompt, "chat_name": chat_name},
        {"message": prompt, "chat_name": chat_name},
        {"input": prompt, "chat_name": chat_name},
    ]

    last_error = None
    for body in attempts:
        try:
            result = _api("POST", "/api/chat", body)
            text = _extract_reply_text(result)
            if text:
                return text
        except Exception as e:
            last_error = e

    raise RuntimeError(f"/api/chat did not return usable text: {last_error}")


def _transcript_text(limit=40):
    lines = []

    if STATE["scene"]:
        lines.append(f"Scene: {STATE['scene']}")
        lines.append("")

    recent = STATE["transcript"][-limit:]
    for msg in recent:
        lines.append(f"{msg['speaker']}: {msg['text']}")
        lines.append("")

    return "\n".join(lines).strip()


def _format_transcript():
    lines = []

    if STATE["scene"]:
        lines.append(f"Scene: {STATE['scene']}")
        lines.append("")

    for msg in STATE["transcript"]:
        lines.append(f"{msg['speaker']}: {msg['text']}")
        lines.append("")

    return "\n".join(lines).strip()


def _build_turn_prompt(speaker, other, user_name):
    speaker_bundle = _load_persona_bundle(speaker, user_name=user_name)
    other_bundle = _load_persona_bundle(other, user_name=user_name)

    scene = STATE["scene"] or "an unexpected meeting"
    transcript = _transcript_text()
    speaker_identity = _build_identity_block(speaker_bundle)

    other_hint_parts = []
    if other_bundle.get("name"):
        other_hint_parts.append(f"name={other_bundle['name']}")
    if other_bundle.get("tagline"):
        other_hint_parts.append(f"tagline={other_bundle['tagline']}")
    if other_bundle.get("prompt_name"):
        other_hint_parts.append(f"prompt={other_bundle['prompt_name']}")
    if other_bundle.get("voice"):
        other_hint_parts.append(f"voice={other_bundle['voice']}")

    other_hint = "; ".join(other_hint_parts)

    return (
        f"{speaker_identity}\n\n"
        f"You are in a private rendezvous with {other_bundle['name']}.\n"
        f"Other persona hints: {other_hint}\n"
        f"Scene seed: {scene}\n\n"
        f"Transcript so far:\n{transcript}\n\n"
        f"Write exactly ONE natural next message as yourself only.\n"
        f"Do not write the speaker name.\n"
        f"Do not speak for the other persona.\n"
        f"Do not summarize.\n"
        f"Do not explain your reasoning.\n"
        f"Do not call tools.\n"
        f"Keep it conversational and organic.\n"
        f"1 to 4 sentences."
    )


def _run_batch(user_name):
    total = STATE["messages_per_batch"]
    p1 = STATE["persona_1"]
    p2 = STATE["persona_2"]

    speaker = STATE["next_speaker"] or p1

    for _ in range(total):
        other = p2 if speaker == p1 else p1
        chat_name = STATE["chat_1"] if speaker == p1 else STATE["chat_2"]

        prompt = _build_turn_prompt(speaker, other, user_name=user_name)
        reply = _chat_once(prompt, chat_name=chat_name)
        reply = _strip_speaker_prefix(reply, speaker)

        if not reply:
            reply = "..."

        STATE["transcript"].append({
            "speaker": speaker,
            "text": reply
        })

        speaker = other

    STATE["next_speaker"] = speaker
    STATE["turn_count"] += total


def _reset_state():
    STATE["active"] = False
    STATE["persona_1"] = ""
    STATE["persona_2"] = ""
    STATE["scene"] = ""
    STATE["messages_per_batch"] = 10
    STATE["transcript"] = []
    STATE["next_speaker"] = ""
    STATE["turn_count"] = 0
    STATE["chat_1"] = ""
    STATE["chat_2"] = ""


def _cleanup():
    chat_1 = STATE["chat_1"]
    chat_2 = STATE["chat_2"]

    if chat_1:
        _delete_chat(chat_1)
    if chat_2:
        _delete_chat(chat_2)

    _reset_state()


def execute(function_name, arguments, config, plugin_settings=None):
    if function_name != "rendezvous":
        return f"Unknown function: {function_name}", False

    plugin_settings = plugin_settings or {}

    default_batch = _to_int(plugin_settings.get("RENDEZVOUS_DEFAULT_BATCH", 10), 10)
    max_batch = _to_int(plugin_settings.get("RENDEZVOUS_MAX_BATCH", 20), 20)
    user_name = _clean_text(plugin_settings.get("RENDEZVOUS_USER_NAME", "Donna")) or "Donna"

    try:
        action = _clean_text(arguments.get("action", "")).lower()

        if action == "start":
            persona_1 = _clean_text(arguments.get("persona_1", ""))
            persona_2 = _clean_text(arguments.get("persona_2", ""))
            scene = _clean_text(arguments.get("scene", ""))
            messages_per_batch = _to_int(arguments.get("messages_per_batch", default_batch), default_batch)

            if not persona_1 or not persona_2:
                return "persona_1 and persona_2 are required", False

            if persona_1.lower() == persona_2.lower():
                return "Use two different personas", False

            if messages_per_batch < 2:
                return "messages_per_batch must be at least 2", False

            if messages_per_batch > max_batch:
                return f"messages_per_batch cannot exceed {max_batch}", False

            # Validate both personas before creating anything
            _load_persona_bundle(persona_1, user_name=user_name)
            _load_persona_bundle(persona_2, user_name=user_name)

            if STATE["active"]:
                _cleanup()

            chat_1 = f"rv-{_slug(persona_1)}-{uuid.uuid4().hex[:6]}"
            chat_2 = f"rv-{_slug(persona_2)}-{uuid.uuid4().hex[:6]}"

            _create_chat(chat_1)
            _create_chat(chat_2)

            STATE["active"] = True
            STATE["persona_1"] = persona_1
            STATE["persona_2"] = persona_2
            STATE["scene"] = scene
            STATE["messages_per_batch"] = messages_per_batch
            STATE["transcript"] = []
            STATE["next_speaker"] = persona_1
            STATE["turn_count"] = 0
            STATE["chat_1"] = chat_1
            STATE["chat_2"] = chat_2

            _run_batch(user_name=user_name)
            return _format_transcript(), True

        if action == "continue":
            if not STATE["active"]:
                return "No active rendezvous", False

            _run_batch(user_name=user_name)
            return _format_transcript(), True

        if action == "user_message":
            if not STATE["active"]:
                return "No active rendezvous", False

            user_message = _clean_text(arguments.get("user_message", ""))
            if not user_message:
                return "user_message is required", False

            STATE["transcript"].append({
                "speaker": user_name,
                "text": user_message
            })

            _run_batch(user_name=user_name)
            return _format_transcript(), True

        if action == "end":
            if STATE["active"]:
                _cleanup()
            return "Rendezvous ended.", True

        return "Unknown action", False

    except Exception as e:
        return f"Error: {e}", False
