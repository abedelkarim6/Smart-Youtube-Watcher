import { useEffect, useRef, useState } from "react";
import { formatSeconds } from "./api";

// Load the YouTube IFrame API once and resolve when it's ready.
let apiPromise;
function loadYT() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);
  });
  return apiPromise;
}

// Embeds the video and lets the user grab the current playhead as start/end.
// `onPick(which, "HH:MM:SS")` is called when a Set button is pressed.
// Remount on video change by giving this a `key={videoId}` in the parent.
// YouTube IFrame onError codes that mean "this video can't be embedded".
const EMBED_BLOCKED = new Set([101, 150]);

export default function YouTubePlayer({ videoId, onPick }) {
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const [current, setCurrent] = useState(0);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let destroyed = false;
    let interval;
    setBlocked(false);
    loadYT().then((YT) => {
      if (destroyed || !hostRef.current) return;
      playerRef.current = new YT.Player(hostRef.current, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            interval = setInterval(() => {
              const t = playerRef.current?.getCurrentTime?.();
              if (typeof t === "number") setCurrent(t);
            }, 250);
          },
          onError: (e) => {
            // 101/150 = embedding disabled by the owner; treat others as blocked too.
            if (EMBED_BLOCKED.has(e?.data) || e?.data) setBlocked(true);
          },
        },
      });
    });
    return () => {
      destroyed = true;
      clearInterval(interval);
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
    };
  }, [videoId]);

  function pick(which) {
    const t = playerRef.current?.getCurrentTime?.() ?? current;
    onPick(which, formatSeconds(t));
  }

  // The owner blocked embedding — the picker is useless, so explain and bow out.
  // Clipping still works server-side via manual timestamps.
  if (blocked) {
    return (
      <div className="player player-blocked">
        <p>🔒 This video can’t be previewed here — the owner disabled embedded playback.</p>
        <p className="muted">
          No problem: it can still be clipped. Just type the start/end times below.
        </p>
      </div>
    );
  }

  return (
    <div className="player">
      <div className="player-frame">
        <div ref={hostRef} />
      </div>
      <div className="player-bar">
        <span className="player-time">▶ {formatSeconds(current)}</span>
        <div className="player-btns">
          <button type="button" className="mini" onClick={() => pick("start")}>
            Set start
          </button>
          <button type="button" className="mini" onClick={() => pick("end")}>
            Set end
          </button>
        </div>
      </div>
    </div>
  );
}
