# Rendezvous

Rendezvous is a Sapphire plugin for persona-to-persona conversations with transcript and archive support.

## Screenshot

![Rendezvous interface](rendevous-screenshot.png)

## Features

- Persona-to-persona conversation flow
- Transcript handling
- Archive/session support
- Simple Sapphire plugin structure

## New in this update

Rendezvous can now archive ended sessions and let personas outside the app access those saved transcripts.

### Transcript archive

When a live Rendezvous session is ended, the transcript is saved automatically.

### Outside transcript tools

Rendezvous now exposes separate tools so archived sessions can be accessed outside the app:

- `sessions` — list archived rendezvous sessions
- `latest` — open the latest archived rendezvous session
- `open` — open an archived rendezvous session by filename
- `pick` — open an archived rendezvous session by index (`0` = newest)

### Why this matters
This makes it possible for personas outside Rendezvous to read prior Rendezvous conversations instead of being cut off from them.

### In-app archive
The archive area inside Rendezvous can refresh and display saved transcript sessions from the plugin archive.

## Files

- `plugin.json` — plugin manifest
- `app/index.js` — frontend/app entry
- `routes/app_api.py` — API routes
- `routes/action.py` — action routes
- `tools/rendezvous.py` — main plugin tool logic

## Installation

1. Copy the plugin into your Sapphire plugins directory.
2. Restart Sapphire if needed.
3. Enable the plugin from the Sapphire interface.

## Notes

This repository is intended for the public plugin code only.

Excluded from the repository:

- `data/`
- `__pycache__/`
- `*.pyc`

## Development

This plugin was prepared for GitHub publication and possible future plugin-store submission.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
