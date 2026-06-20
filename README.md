# Smart YouTube Watcher — YouTube Clip Downloader

A small web app that downloads an exact trimmed slice of a YouTube video.
React frontend + FastAPI backend wrapping [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Features
- Paste a URL, set **start**/**end** (`HH:MM:SS`, `MM:SS`, or seconds), pick a quality.
- Leave start/end empty to grab from the beginning / to the very end.
- **Video preview** on paste — thumbnail, title, channel, and duration.
- **In-browser player** with **Set start / Set end** buttons to grab timestamps by scrubbing.
- **Live clip length** ("Clipping 2m 42s") and inline validation before you download.
- **Live progress** pushed over SSE (percent, speed, ETA), then a one-click download.
- **Quality / format**: best, 1080/720/480p, audio-only **MP3** (selectable bitrate), or **GIF**.
- **Embed subtitles** (English) into video clips when available.
- **Queue multiple clips** at once — each runs independently with its own progress + **Cancel**.
- **Clipboard paste** button + automatic URL cleaning (strips tracking/playlist params).
- **ffmpeg health banner** warns if the server is missing ffmpeg.
- Finished clips are **auto-deleted** from the server after a few hours.

## Requirements
- **Python 3.9+** and **Node 18+**
- **ffmpeg** on your PATH (needed for trimming & merging)
  - Windows: `winget install Gyan.FFmpeg` (or `choco install ffmpeg`)
  - Ubuntu / Debian: `sudo apt update && sudo apt install -y ffmpeg`
  - Fedora: `sudo dnf install -y ffmpeg`
  - Arch: `sudo pacman -S ffmpeg`
  - macOS: `brew install ffmpeg`
  - Verify with: `ffmpeg -version`

## Run the backend
```bash
# from the project root, using the bundled virtual environment
# Linux/macOS:  source .venv/bin/activate
# Windows:      .venv\Scripts\activate
pip install -r backend/requirements.txt   # first time only
cd backend
uvicorn app:app --reload --port 8000
```

## Run the frontend
```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5173 — the dev server proxies `/api` to the backend on port 8000.

## How it works
Pasting a URL hits `GET /api/info` for preview metadata. Each clip is a background
job (`POST /api/download` → `job_id`); the UI opens a **Server-Sent Events** stream at
`GET /api/jobs/{id}/events` and the backend *pushes* progress (percent, speed, ETA,
status) as it happens — no polling. Running jobs can be stopped with
`POST /api/jobs/{id}/cancel`, and the finished file is fetched from
`GET /api/jobs/{id}/file`. `GET /api/health` reports whether ffmpeg is available.

Trimming uses yt-dlp's `download_ranges` with `force_keyframes_at_cuts` so cuts
land cleanly. GIFs are produced with a two-pass ffmpeg palette for quality.

### API
| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/info?url=` | Preview metadata (no download) |
| POST | `/api/download` | Start a clip job → `{ job_id }` |
| GET  | `/api/jobs/{id}/events` | SSE progress stream |
| POST | `/api/jobs/{id}/cancel` | Cancel a running job |
| GET  | `/api/jobs/{id}/file` | Download the finished clip |
| GET  | `/api/jobs/{id}` | One-shot status snapshot (fallback) |
| GET  | `/api/health` | `{ ok, ffmpeg }` |
