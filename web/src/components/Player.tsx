import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface PlayerHandle {
  seek(seconds: number): void;
  currentTime(): number | null;
}

interface YTPlayer {
  seekTo(s: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApi: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  ytApi ??= new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytApi;
}

/** YouTube video or uploaded-audio player that the transcript can control. */
export const Player = forwardRef<PlayerHandle, { youtubeId?: string | null; startAt?: number }>(function Player(
  { youtubeId, startAt },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const yt = useRef<YTPlayer | null>(null);
  const ytReady = useRef(false);
  const pendingSeek = useRef<number | null>(startAt ?? null);
  const audio = useRef<HTMLAudioElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!youtubeId || !host.current) return;
    let cancelled = false;
    const el = document.createElement("div");
    host.current.appendChild(el);
    loadYouTubeApi().then(() => {
      if (cancelled || !window.YT) return;
      yt.current = new window.YT.Player(el, {
        videoId: youtubeId,
        width: "100%",
        height: "100%",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            ytReady.current = true;
            if (pendingSeek.current !== null) {
              yt.current?.seekTo(pendingSeek.current, true);
              yt.current?.playVideo();
              pendingSeek.current = null;
            }
          },
        },
      });
    });
    return () => {
      cancelled = true;
      yt.current?.destroy();
      yt.current = null;
      ytReady.current = false;
    };
  }, [youtubeId]);

  useEffect(() => () => void (audioUrl && URL.revokeObjectURL(audioUrl)), [audioUrl]);

  useImperativeHandle(ref, () => ({
    seek(s) {
      if (youtubeId) {
        if (ytReady.current && yt.current) {
          yt.current.seekTo(s, true);
          yt.current.playVideo();
        } else pendingSeek.current = s;
      } else if (audio.current) {
        audio.current.currentTime = s;
        void audio.current.play();
      }
    },
    currentTime() {
      if (youtubeId) {
        if (!ytReady.current || !yt.current) return null;
        // 1 = playing, 2 = paused, 3 = buffering
        return [1, 2, 3].includes(yt.current.getPlayerState()) ? yt.current.getCurrentTime() : null;
      }
      return audio.current && audio.current.currentTime > 0 ? audio.current.currentTime : null;
    },
  }));

  if (youtubeId) {
    return <div ref={host} className="aspect-video w-full overflow-hidden rounded-xl bg-black [&>iframe]:size-full [&>div]:size-full" />;
  }
  // Uploaded recordings play from this device (the original file isn't streamed back from the server).
  return audioUrl ? (
    <audio ref={audio} src={audioUrl} controls preload="metadata" className="w-full" />
  ) : (
    <label className="block cursor-pointer rounded-xl border-2 border-dashed border-line bg-card p-4 text-center hover:border-brand">
      <span className="font-medium text-brand">Choose the recording on this device</span>
      <span className="mt-1 block text-sm text-muted">to listen along with the transcript</span>
      <input type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => e.target.files?.[0] && setAudioUrl(URL.createObjectURL(e.target.files[0]))} />
    </label>
  );
});
