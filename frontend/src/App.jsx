import { useEffect, useMemo, useRef, useState } from "react";
import YouTubePlayer from "./YouTubePlayer";
import {
  cancelJob,
  cleanYouTubeUrl,
  fetchHealth,
  fetchInfo,
  fmtBytes,
  fmtEta,
  fmtSpeed,
  formatSeconds,
  humanDuration,
  parseTimeToSeconds,
  startDownload,
} from "./api";

const QUALITIES = [
  { value: "best", label: "Best" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "audio", label: "Audio (MP3)" },
  { value: "gif", label: "GIF" },
];

const BITRATES = ["320", "256", "192", "128"];

const STATUS_LABEL = {
  queued: "Queued…",
  downloading: "Downloading",
  processing: "Processing…",
  done: "Ready",
  error: "Failed",
  cancelled: "Cancelled",
};

const ACTIVE = ["queued", "downloading", "processing"];

export default function App() {
  const [url, setUrl] = useState("");
  const [start, setStart] = useState("00:00:00");
  const [end, setEnd] = useState("");
  const [quality, setQuality] = useState("best");
  const [bitrate, setBitrate] = useState("192");
  const [subtitles, setSubtitles] = useState(false);

  const [info, setInfo] = useState(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState("");

  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [jobs, setJobs] = useState([]); // newest first
  const [formError, setFormError] = useState("");

  const esMap = useRef({}); // jobId -> EventSource
  const infoAbort = useRef(null);

  // --- ffmpeg health check on load -----------------------------------------
  useEffect(() => {
    fetchHealth()
      .then((h) => setFfmpegOk(!!h.ffmpeg))
      .catch(() => setFfmpegOk(true)); // don't nag if health is unreachable
  }, []);

  // --- debounced video metadata lookup -------------------------------------
  useEffect(() => {
    const trimmed = url.trim();
    setInfoError("");
    if (!trimmed) {
      setInfo(null);
      return;
    }
    const t = setTimeout(() => {
      infoAbort.current?.abort();
      const ctrl = new AbortController();
      infoAbort.current = ctrl;
      setInfoLoading(true);
      fetchInfo(trimmed, ctrl.signal)
        .then((data) => {
          setInfo(data);
          setInfoError("");
        })
        .catch((e) => {
          if (e.name !== "AbortError") {
            setInfo(null);
            setInfoError(e.message);
          }
        })
        .finally(() => setInfoLoading(false));
    }, 600);
    return () => clearTimeout(t);
  }, [url]);

  // --- tidy up SSE connections on unmount ----------------------------------
  useEffect(() => {
    const map = esMap.current;
    return () => Object.values(map).forEach((es) => es.close());
  }, []);

  // --- validation / derived values -----------------------------------------
  const startSec = parseTimeToSeconds(start);
  const endSec = parseTimeToSeconds(end);

  const validation = useMemo(() => {
    if (Number.isNaN(startSec)) return "Start time isn't a valid timestamp.";
    if (Number.isNaN(endSec)) return "End time isn't a valid timestamp.";
    if (startSec != null && endSec != null && endSec <= startSec)
      return "End time must be after the start time.";
    if (info?.duration != null) {
      if (startSec != null && startSec >= info.duration)
        return "Start is past the end of the video.";
      if (endSec != null && endSec > info.duration + 1)
        return `End is beyond the video length (${formatSeconds(info.duration)}).`;
    }
    return "";
  }, [startSec, endSec, info]);

  const clipLength = useMemo(() => {
    const from = startSec || 0;
    const to = endSec != null ? endSec : info?.duration;
    if (to == null || Number.isNaN(from)) return null;
    const len = to - from;
    return len > 0 ? len : null;
  }, [startSec, endSec, info]);

  const canSubmit = url.trim() && !validation && ffmpegOk;

  // --- job lifecycle -------------------------------------------------------
  function updateJob(jobId, patch) {
    setJobs((js) => js.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)));
  }

  function subscribe(jobId) {
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    esMap.current[jobId] = es;
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      updateJob(jobId, data);
      if (["done", "error", "cancelled"].includes(data.status)) {
        es.close();
        delete esMap.current[jobId];
      }
    };
    es.onerror = () => {
      es.close();
      delete esMap.current[jobId];
      // Only surface an error if the job hadn't already reached a terminal state.
      setJobs((js) =>
        js.map((j) =>
          j.jobId === jobId && ACTIVE.includes(j.status)
            ? { ...j, status: "error", error: "Lost connection." }
            : j
        )
      );
    };
  }

  async function enqueue(e) {
    e.preventDefault();
    setFormError("");
    if (!url.trim()) return setFormError("Paste a YouTube URL first.");
    if (validation) return setFormError(validation);
    if (!ffmpegOk) return setFormError("ffmpeg isn't installed on the server.");

    const label = `${info?.title || url.trim()} · ${start || "0:00"}–${end || "end"}`;
    try {
      const { job_id } = await startDownload({
        url: url.trim(),
        start,
        end,
        quality,
        audio_bitrate: bitrate,
        subtitles,
      });
      setJobs((js) => [
        { jobId: job_id, status: "queued", progress: 0, label, quality },
        ...js,
      ]);
      subscribe(job_id);
    } catch (err) {
      setFormError(err.message);
    }
  }

  async function onCancel(jobId) {
    await cancelJob(jobId).catch(() => {});
  }

  function removeJob(jobId) {
    esMap.current[jobId]?.close();
    delete esMap.current[jobId];
    setJobs((js) => js.filter((j) => j.jobId !== jobId));
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(cleanYouTubeUrl(text));
    } catch {
      setFormError("Couldn't read the clipboard — paste manually.");
    }
  }

  function pickTime(which, value) {
    if (which === "start") setStart(value);
    else setEnd(value);
  }

  // -------------------------------------------------------------------------
  return (
    <div className="page">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <main className="card">
        <header className="head">
          <div className="logo">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              <line x1="20" y1="4" x2="8.12" y2="15.88" />
              <line x1="14.47" y1="14.48" x2="20" y2="20" />
              <line x1="8.12" y1="8.12" x2="12" y2="12" />
            </svg>
          </div>
          <div>
            <h1>Smart YouTube Watcher</h1>
            <p className="sub">Grab the exact slice of any YouTube video.</p>
          </div>
        </header>

        {!ffmpegOk && (
          <div className="alert warn">
            ⚠ <strong>ffmpeg isn't installed on the server.</strong> Clips can't be
            trimmed or merged until it's available. See the README for install steps.
          </div>
        )}

        <form onSubmit={enqueue} className="form">
          <label className="field">
            <span>Video URL</span>
            <div className="url-row">
              <input
                type="text"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => setUrl((u) => cleanYouTubeUrl(u))}
              />
              <button type="button" className="mini" onClick={pasteFromClipboard}>
                Paste
              </button>
            </div>
          </label>

          {/* Preview card */}
          {infoLoading && <div className="preview skeleton">Loading video…</div>}
          {infoError && !infoLoading && <div className="alert">{infoError}</div>}
          {info && !infoLoading && (
            <div className="preview">
              {info.thumbnail && <img src={info.thumbnail} alt="" className="thumb" />}
              <div className="preview-meta">
                <p className="preview-title">{info.title}</p>
                <p className="muted">
                  {info.channel}
                  {info.duration != null && ` · ${formatSeconds(info.duration)}`}
                </p>
              </div>
            </div>
          )}

          {/* In-browser timestamp picker */}
          {info?.id && (
            <YouTubePlayer key={info.id} videoId={info.id} onPick={pickTime} />
          )}

          <div className="row">
            <label className="field">
              <span>Start</span>
              <input
                type="text"
                placeholder="00:00:00"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label className="field">
              <span>End</span>
              <input
                type="text"
                placeholder="leave empty = end"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>

          {clipLength != null && !validation && (
            <p className="cliplen">Clipping {humanDuration(clipLength)}</p>
          )}
          {validation && <p className="cliplen err">{validation}</p>}

          <div className="field">
            <span>Quality</span>
            <div className="chips">
              {QUALITIES.map((q) => (
                <button
                  type="button"
                  key={q.value}
                  className={`chip ${quality === q.value ? "chip-on" : ""}`}
                  onClick={() => setQuality(q.value)}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          {/* Format-specific options */}
          {quality === "audio" && (
            <label className="field">
              <span>Audio bitrate (kbps)</span>
              <div className="chips">
                {BITRATES.map((b) => (
                  <button
                    type="button"
                    key={b}
                    className={`chip ${bitrate === b ? "chip-on" : ""}`}
                    onClick={() => setBitrate(b)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </label>
          )}

          {!["audio", "gif"].includes(quality) && (
            <label className="check">
              <input
                type="checkbox"
                checked={subtitles}
                onChange={(e) => setSubtitles(e.target.checked)}
              />
              <span>Embed English subtitles (if available)</span>
            </label>
          )}

          <button type="submit" className="cta" disabled={!canSubmit}>
            {jobs.some((j) => ACTIVE.includes(j.status)) ? "Add to queue" : "Clip it"}
          </button>
          {formError && <div className="alert">{formError}</div>}
        </form>

        {/* Queue / history */}
        {jobs.length > 0 && (
          <section className="queue">
            <h2 className="queue-h">Clips</h2>
            {jobs.map((job) => (
              <JobRow key={job.jobId} job={job} onCancel={onCancel} onRemove={removeJob} />
            ))}
          </section>
        )}

        <footer className="foot">
          Times accept <code>HH:MM:SS</code>, <code>MM:SS</code>, or seconds. Clips are
          auto-deleted from the server after a few hours.
        </footer>
      </main>
    </div>
  );
}

function JobRow({ job, onCancel, onRemove }) {
  const active = ACTIVE.includes(job.status);
  return (
    <div className="job">
      <div className="job-top">
        <span className={`dot dot-${job.status}`} />
        <span className="job-label" title={job.label}>{job.label}</span>
        <span className="job-status">{STATUS_LABEL[job.status] || job.status}</span>
      </div>

      {active && (
        <div className="bar">
          <div
            className={`bar-fill ${job.status === "processing" ? "indet" : ""}`}
            style={{ width: `${job.status === "processing" ? 100 : job.progress || 0}%` }}
          />
        </div>
      )}

      <div className="job-foot">
        {job.status === "downloading" && (
          <span className="muted">
            {(job.progress || 0).toFixed(0)}% · {fmtSpeed(job.speed)}
            {job.eta != null && ` · ${fmtEta(job.eta)}`}
          </span>
        )}
        {job.status === "done" && (
          <span className="muted">{job.size ? fmtBytes(job.size) : "Ready"}</span>
        )}
        {(job.status === "error" || job.status === "cancelled") && (
          <span className="muted err-text" title={job.error}>{job.error}</span>
        )}

        <div className="job-actions">
          {active && (
            <button className="mini ghost-mini" onClick={() => onCancel(job.jobId)}>
              Cancel
            </button>
          )}
          {job.status === "done" && (
            <a className="mini solid-mini" href={`/api/jobs/${job.jobId}/file`}>
              ⬇ Download
            </a>
          )}
          {!active && (
            <button className="mini ghost-mini" onClick={() => onRemove(job.jobId)}>
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
