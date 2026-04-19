from fastapi.responses import JSONResponse


async def handle_action(request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid JSON body"}, status_code=400)

    action = str(payload.get("action", "")).strip().lower()

    if action not in {"start", "continue", "user_message", "end"}:
        return JSONResponse({"ok": False, "error": "Unknown action"}, status_code=400)

    return JSONResponse({
        "ok": True,
        "status": "accepted",
        "echo": payload
    })
