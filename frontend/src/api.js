// Small shared helpers: API calls, time/size formatting, URL cleaning.

export async function fetchInfo(url, signal) {
  const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`, { signal });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || "Could not read this video.");
  }
  return res.json();
}

export async function startDownload(payload) {
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || "Could not start the download.");
  }
  return res.json(); // { job_id }
}

export async function cancelJob(jobId) {
  await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
}

export async function fetchHealth() {
  const res = await fetch("/api/health");
  return res.json(); // { ok, ffmpeg }
}

// "1:02:03" | "2:03" | "123" -> seconds (number) or null if blank/invalid.
export function parseTimeToSeconds(value) {
  if (value == null || String(value).trim() === "") return null;
  const v = String(value).trim();
  const parts = v.split(":");
  if (parts.length > 3) return NaN;
  let s = 0;
  for (const p of parts) {
    if (p !== "" && Number.isNaN(Number(p))) return NaN;
    s = s * 60 + Number(p || 0);
  }
  return s;
}

// seconds -> "HH:MM:SS"
export function formatSeconds(total) {
  if (total == null || Number.isNaN(total)) return "00:00:00";
  total = Math.max(0, Math.floor(total));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

// seconds -> "2m 42s" / "45s"
export function humanDuration(total) {
  if (total == null || Number.isNaN(total) || total < 0) return "";
  total = Math.round(total);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec) return "";
  const mb = bytesPerSec / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

export function fmtEta(sec) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}m ${s}s left` : `${s}s left`;
}

export function fmtBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Strip tracking/playlist cruft, keep a clean canonical watch URL when possible.
export function cleanYouTubeUrl(raw) {
  if (!raw) return raw;
  const url = raw.trim();
  const id = extractVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : url;
}

export function extractVideoId(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1) || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = u.pathname.match(/\/(shorts|embed)\/([^/?]+)/);
    if (m) return m[2];
  } catch {
    /* not a URL */
  }
  return null;
}
