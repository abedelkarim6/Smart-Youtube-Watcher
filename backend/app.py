"""
YouTube Clip Downloader — FastAPI backend.

Wraps yt-dlp to download a trimmed section of a YouTube video.
Downloads run as background jobs and the backend *pushes* live progress to the
frontend over Server-Sent Events (SSE) — no polling.

Run:
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000

Requires ffmpeg on PATH for trimming/merging (and for GIF/subtitle output).
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import yt_dlp
from yt_dlp.utils import download_range_func

try:  # yt-dlp signals a hook-requested abort with this exception type.
    from yt_dlp.utils import DownloadCancelled
except ImportError:  # pragma: no cover - very old yt-dlp
    class DownloadCancelled(Exception):
        pass

DOWNLOAD_DIR = Path(__file__).parent / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

# Finished clips are kept on disk for this long, then auto-deleted.
MAX_FILE_AGE_HOURS = 6
CLEANUP_INTERVAL_SECONDS = 30 * 60

def _find_ffmpeg() -> Optional[str]:
    """Locate ffmpeg even when it isn't on PATH (common right after a winget install).

    Falls back to the standard winget / chocolatey / manual install locations on
    Windows so the server works without the user restarting their whole machine.
    """
    exe = shutil.which("ffmpeg")
    if exe:
        return exe

    patterns = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        patterns.append(
            os.path.join(local, "Microsoft", "WinGet", "Packages",
                         "Gyan.FFmpeg*", "**", "ffmpeg.exe")
        )
    patterns += [
        r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
        r"C:\ffmpeg\bin\ffmpeg.exe",
    ]
    for pattern in patterns:
        for match in glob.glob(pattern, recursive=True):
            if os.path.isfile(match):
                return match
    return None


FFMPEG_EXE = _find_ffmpeg()
FFMPEG_AVAILABLE = FFMPEG_EXE is not None
# Directory handed to yt-dlp via `ffmpeg_location` so it doesn't need PATH either.
FFMPEG_DIR = str(Path(FFMPEG_EXE).parent) if FFMPEG_EXE else None

# Belt-and-suspenders: also put ffmpeg on this process's PATH so every internal
# yt-dlp check (some don't honor `ffmpeg_location`) and any subprocess find it.
if FFMPEG_DIR and FFMPEG_DIR not in os.environ.get("PATH", ""):
    os.environ["PATH"] = FFMPEG_DIR + os.pathsep + os.environ.get("PATH", "")

app = FastAPI(title="YouTube Clip Downloader")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job store. Fine for a single-process local tool.
# Each job: {"state": {...}, "queue": Queue, "cancel": threading.Event}.
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

# Sentinel pushed onto a job's queue once it reaches a terminal state.
_DONE = object()


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class DownloadRequest(BaseModel):
    url: str
    start: Optional[str] = None  # "HH:MM:SS", "MM:SS", or seconds. None = from start
    end: Optional[str] = None    # same formats. None = to the end
    quality: str = "best"        # best | 1080 | 720 | 480 | audio | gif
    audio_bitrate: str = "192"   # kbps, used when quality == "audio"
    subtitles: bool = False      # embed English subtitles (video formats only)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def parse_timestamp(value: Optional[str]) -> Optional[float]:
    """Convert 'HH:MM:SS', 'MM:SS', or plain seconds into a float of seconds."""
    if value is None or str(value).strip() == "":
        return None
    value = str(value).strip()
    if ":" not in value:
        return float(value)
    parts = value.split(":")
    if len(parts) > 3:
        raise ValueError(f"Invalid timestamp: {value}")
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


def format_selector(quality: str) -> str:
    if quality == "audio":
        return "bestaudio/best"
    if quality in ("best", "gif"):
        return "bestvideo+bestaudio/best"
    # numeric height cap, e.g. "720"
    return f"bestvideo[height<={quality}]+bestaudio/best[height<={quality}]/best"


def set_job(job_id: str, **fields) -> None:
    """Update a job's state and push the new snapshot to its SSE subscriber."""
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return
        job["state"].update(fields)
        snapshot = {"job_id": job_id, **job["state"]}
        q = job["queue"]
    q.put(snapshot)
    if snapshot["status"] in ("done", "error", "cancelled"):
        q.put(_DONE)


def convert_to_gif(src: Path, job_id: str) -> Path:
    """Convert a downloaded clip to an optimized GIF using ffmpeg (two-pass palette)."""
    gif_path = DOWNLOAD_DIR / f"{job_id}.gif"
    vf = "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
    subprocess.run(
        [FFMPEG_EXE or "ffmpeg", "-y", "-i", str(src), "-vf", vf, "-loop", "0", str(gif_path)],
        check=True,
        capture_output=True,
    )
    return gif_path


def run_download(job_id: str, req: DownloadRequest) -> None:
    try:
        start = parse_timestamp(req.start)
        end = parse_timestamp(req.end)
    except ValueError as exc:
        set_job(job_id, status="error", error=str(exc))
        return

    with jobs_lock:
        cancel_event: threading.Event = jobs[job_id]["cancel"]

    out_template = str(DOWNLOAD_DIR / f"{job_id}.%(ext)s")

    def progress_hook(d: dict) -> None:
        if cancel_event.is_set():
            raise DownloadCancelled()
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            downloaded = d.get("downloaded_bytes", 0)
            pct = (downloaded / total * 100) if total else 0
            set_job(
                job_id,
                status="downloading",
                progress=round(pct, 1),
                speed=d.get("speed"),
                eta=d.get("eta"),
            )
        elif d["status"] == "finished":
            set_job(job_id, status="processing", progress=100.0)

    ydl_opts = {
        "format": format_selector(req.quality),
        "outtmpl": out_template,
        "progress_hooks": [progress_hook],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    if FFMPEG_DIR:
        ydl_opts["ffmpeg_location"] = FFMPEG_DIR

    postprocessors = []
    if req.quality == "audio":
        postprocessors.append(
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": req.audio_bitrate,
            }
        )
    else:
        ydl_opts["merge_output_format"] = "mp4"

    # Subtitles only make sense for video formats.
    if req.subtitles and req.quality not in ("audio", "gif"):
        ydl_opts["writesubtitles"] = True
        ydl_opts["writeautomaticsub"] = True
        ydl_opts["subtitleslangs"] = ["en", "en-US", "en-orig"]
        postprocessors.append({"key": "FFmpegEmbedSubtitle"})

    if postprocessors:
        ydl_opts["postprocessors"] = postprocessors

    # Trim only if a range was supplied.
    if start is not None or end is not None:
        ydl_opts["download_ranges"] = download_range_func(
            None, [(start or 0, end if end is not None else float("inf"))]
        )
        ydl_opts["force_keyframes_at_cuts"] = True

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.url, download=True)
            title = info.get("title", "video")

        produced = sorted(
            (p for p in DOWNLOAD_DIR.glob(f"{job_id}.*") if p.suffix != ".part"),
            key=lambda p: p.stat().st_size,
            reverse=True,
        )
        if not produced:
            set_job(job_id, status="error", error="No output file was produced.")
            return
        result_path = produced[0]

        # Post-convert to GIF if requested.
        if req.quality == "gif":
            if not FFMPEG_AVAILABLE:
                set_job(job_id, status="error", error="ffmpeg is required for GIF export.")
                return
            set_job(job_id, status="processing", progress=100.0)
            gif_path = convert_to_gif(result_path, job_id)
            result_path.unlink(missing_ok=True)
            result_path = gif_path

        safe_title = re.sub(r'[<>:"/\\|?*]', "_", title)[:120]
        download_name = f"{safe_title}{result_path.suffix}"

        set_job(
            job_id,
            status="done",
            progress=100.0,
            title=title,
            filename=result_path.name,
            download_name=download_name,
            size=result_path.stat().st_size,
        )
    except DownloadCancelled:
        for leftover in DOWNLOAD_DIR.glob(f"{job_id}.*"):
            leftover.unlink(missing_ok=True)
        set_job(job_id, status="cancelled", error="Cancelled.")
    except subprocess.CalledProcessError as exc:
        msg = (exc.stderr or b"").decode(errors="ignore")[-400:] or "ffmpeg failed."
        set_job(job_id, status="error", error=msg)
    except Exception as exc:  # noqa: BLE001 — surface any yt-dlp error to the UI
        if cancel_event.is_set():
            set_job(job_id, status="cancelled", error="Cancelled.")
        else:
            set_job(job_id, status="error", error=str(exc))


def cleanup_old_files() -> None:
    """Delete clips (and their job records) older than MAX_FILE_AGE_HOURS."""
    cutoff = time.time() - MAX_FILE_AGE_HOURS * 3600
    for path in DOWNLOAD_DIR.glob("*"):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            pass
    # Drop job records whose files are gone.
    with jobs_lock:
        for job_id, job in list(jobs.items()):
            fname = job["state"].get("filename")
            if fname and not (DOWNLOAD_DIR / fname).exists():
                jobs.pop(job_id, None)


def _cleanup_loop() -> None:
    while True:
        time.sleep(CLEANUP_INTERVAL_SECONDS)
        cleanup_old_files()


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.on_event("startup")
def _on_startup() -> None:
    cleanup_old_files()
    threading.Thread(target=_cleanup_loop, daemon=True).start()


@app.get("/api/info")
def video_info(url: str) -> dict:
    """Fetch lightweight metadata for the preview card (no download)."""
    if not url.strip():
        raise HTTPException(status_code=400, detail="A video URL is required.")
    try:
        with yt_dlp.YoutubeDL(
            {"quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True}
        ) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read video: {exc}")

    thumbs = info.get("thumbnails") or []
    thumb = info.get("thumbnail") or (thumbs[-1]["url"] if thumbs else None)
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": thumb,
        "webpage_url": info.get("webpage_url", url),
    }


@app.post("/api/download")
def start_download(req: DownloadRequest) -> dict:
    if not req.url.strip():
        raise HTTPException(status_code=400, detail="A video URL is required.")

    # Validate the time range up front so users get a clear error.
    try:
        start = parse_timestamp(req.start)
        end = parse_timestamp(req.end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if start is not None and start < 0:
        raise HTTPException(status_code=400, detail="Start time cannot be negative.")
    if start is not None and end is not None and end <= start:
        raise HTTPException(status_code=400, detail="End time must be after start time.")

    if not FFMPEG_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg is not installed on the server — it's required to trim and merge clips.",
        )

    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {
            "state": {"status": "queued", "progress": 0.0},
            "queue": queue.Queue(),
            "cancel": threading.Event(),
        }

    threading.Thread(target=run_download, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        job["cancel"].set()
    return {"job_id": job_id, "cancelling": True}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request) -> StreamingResponse:
    """Stream live progress for a job over Server-Sent Events."""
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    q: queue.Queue = job["queue"]

    async def event_stream():
        # Emit the current snapshot immediately so a late subscriber isn't blank.
        with jobs_lock:
            current = {"job_id": job_id, **jobs[job_id]["state"]}
        yield f"data: {json.dumps(current)}\n\n"
        if current["status"] in ("done", "error", "cancelled"):
            return

        while True:
            if await request.is_disconnected():
                break
            try:
                # Block off the event loop in a worker thread with a short timeout
                # so we can periodically re-check for client disconnects.
                item = await asyncio.to_thread(q.get, True, 1.0)
            except queue.Empty:
                yield ": keep-alive\n\n"
                continue
            if item is _DONE:
                break
            yield f"data: {json.dumps(item)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    """One-shot status snapshot (handy as a fallback / for debugging)."""
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        return {"job_id": job_id, **job["state"]}


@app.get("/api/jobs/{job_id}/file")
def job_file(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None or job["state"].get("status") != "done":
        raise HTTPException(status_code=404, detail="File not ready.")
    state = job["state"]
    path = DOWNLOAD_DIR / state["filename"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing on disk.")
    return FileResponse(
        path,
        filename=state.get("download_name", path.name),
        media_type="application/octet-stream",
    )


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "ffmpeg": FFMPEG_AVAILABLE}
