import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFfmpegDuration, parseSilences, type Silence } from "./chunking.ts";
import { classifyYtDlpError, JobError } from "./errors.ts";
import type { CaptionTrack } from "./captions.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a process; keeps the last ~200KB of stderr. */
export function run(cmd: string, args: string[], opts: { onStderrLine?: (line: string) => void; onStdoutLine?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let errBuf = "";
    let outBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (opts.onStdoutLine) {
        outBuf += s;
        const lines = outBuf.split(/\r?\n|\r/);
        outBuf = lines.pop() ?? "";
        lines.forEach(opts.onStdoutLine);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-200_000);
      if (opts.onStderrLine) {
        errBuf += s;
        const lines = errBuf.split(/\r?\n|\r/);
        errBuf = lines.pop() ?? "";
        lines.forEach(opts.onStderrLine);
      }
    });
    child.on("error", (e) => reject(new Error(`Could not start ${cmd}: ${e.message}`)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export interface YouTubeMeta {
  id: string;
  title: string;
  duration: number | null;
  uploadDate: string | null; // YYYY-MM-DD
  channel: string | null;
  thumbnail: string | null;
  liveStatus: string | null;
  language: string | null;
  subtitles: Record<string, unknown>;
  automatic_captions: Record<string, unknown>;
}

export interface MediaOptions {
  ffmpegPath: string;
  ytdlpPath: string;
  cookiesFile?: string | null;
  proxy?: string | null;
  /** yt-dlp --js-runtimes value; "" disables. Defaults to this Node binary. */
  jsRuntime?: string;
}

export function createMedia(opts: MediaOptions) {
  const ytBase = (): string[] => {
    const a = ["--no-playlist", "--ignore-config", "--ffmpeg-location", opts.ffmpegPath];
    // YouTube needs a JavaScript runtime to solve its player challenges; Node is always present here.
    if (opts.jsRuntime !== "") a.push("--js-runtimes", opts.jsRuntime ?? `node:${process.execPath}`);
    if (opts.cookiesFile) a.push("--cookies", opts.cookiesFile);
    if (opts.proxy) a.push("--proxy", opts.proxy);
    return a;
  };

  async function ytdlp(args: string[], onLine?: (l: string) => void): Promise<RunResult> {
    const r = await run(opts.ytdlpPath, [...ytBase(), ...args], { onStdoutLine: onLine });
    if (r.code !== 0) throw classifyYtDlpError(r.stderr || r.stdout);
    return r;
  }

  async function ffmpeg(args: string[]): Promise<RunResult> {
    const r = await run(opts.ffmpegPath, ["-hide_banner", "-nostdin", ...args]);
    if (r.code !== 0) throw new JobError("AUDIO_PROCESSING", "We couldn't read this audio file. Is it a valid audio/video recording?", true, r.stderr.slice(-2000));
    return r;
  }

  return {
    async youtubeMetadata(url: string): Promise<YouTubeMeta> {
      const r = await ytdlp(["-J", "--skip-download", url]);
      const j = JSON.parse(r.stdout);
      const d = typeof j.upload_date === "string" && /^\d{8}$/.test(j.upload_date) ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6, 8)}` : null;
      return {
        id: j.id,
        title: j.title ?? "Untitled class",
        duration: typeof j.duration === "number" ? j.duration : null,
        uploadDate: d,
        channel: j.channel ?? j.uploader ?? null,
        thumbnail: j.thumbnail ?? null,
        liveStatus: j.live_status ?? null,
        language: j.language ?? null,
        subtitles: j.subtitles ?? {},
        automatic_captions: j.automatic_captions ?? {},
      };
    },

    /** Download best audio-only stream. Returns the downloaded file path. Skips if already complete. */
    async downloadYouTubeAudio(url: string, dir: string, onProgress?: (pct: number) => void): Promise<string> {
      await fs.mkdir(dir, { recursive: true });
      const existing = await findFile(dir, "source.");
      if (existing && (await exists(path.join(dir, ".download-complete")))) return existing;
      await ytdlp(
        ["-f", "bestaudio[ext=m4a]/bestaudio/best", "--retries", "10", "--fragment-retries", "10", "--progress", "--newline", "-o", path.join(dir, "source.%(ext)s"), url],
        (line) => {
          const m = line.match(/\[download\]\s+([\d.]+)%/);
          if (m && onProgress) onProgress(Number(m[1]) / 100);
        },
      );
      const file = await findFile(dir, "source.");
      if (!file) throw new JobError("DOWNLOAD_FAILED", "The download finished but no audio file was produced. We'll retry automatically.", false);
      await fs.writeFile(path.join(dir, ".download-complete"), "");
      return file;
    },

    /** Download one caption track as json3; returns its content or null. */
    async fetchCaptions(url: string, dir: string, track: CaptionTrack): Promise<string | null> {
      await fs.mkdir(dir, { recursive: true });
      await ytdlp(["--skip-download", track.auto ? "--write-auto-subs" : "--write-subs", "--sub-langs", track.lang, "--sub-format", "json3", "-o", path.join(dir, "captions.%(ext)s"), url]);
      const file = await findFile(dir, "captions.");
      return file ? fs.readFile(file, "utf8") : null;
    },

    /** Convert anything to 16 kHz mono MP3 (small, and accepted by every provider). */
    async normalizeAudio(input: string, output: string): Promise<string> {
      if (await exists(output)) return output;
      const tmp = output + ".part.mp3";
      await ffmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", tmp]);
      await fs.rename(tmp, output);
      return output;
    },

    async duration(file: string): Promise<number> {
      const r = await run(opts.ffmpegPath, ["-hide_banner", "-i", file]);
      const d = parseFfmpegDuration(r.stderr);
      if (d === null) throw new JobError("AUDIO_PROCESSING", "We couldn't read the length of this recording.", true, r.stderr.slice(-1000));
      return d;
    },

    async detectSilences(file: string): Promise<Silence[]> {
      const r = await ffmpeg(["-i", file, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"]);
      return parseSilences(r.stderr);
    },

    async extractChunk(file: string, start: number, end: number, output: string): Promise<string> {
      await ffmpeg(["-y", "-ss", start.toFixed(3), "-i", file, "-t", (end - start).toFixed(3), "-c", "copy", output]);
      return output;
    },
  };
}

export type Media = ReturnType<typeof createMedia>;

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function findFile(dir: string, prefix: string): Promise<string | null> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const f = files.find((n) => n.startsWith(prefix) && !n.endsWith(".part") && !n.endsWith(".ytdl"));
  return f ? path.join(dir, f) : null;
}
