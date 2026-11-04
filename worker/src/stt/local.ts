import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { SttError, type SttProvider, type SttResult } from "./types.ts";

/**
 * Free local Whisper (faster-whisper) via a long-lived Python process.
 * Nothing leaves the computer; no API key, no quota.
 */
export function localWhisperProvider(opts: { python: string; model: string; env?: Record<string, string> }): SttProvider & { close(): void } {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  const waiting: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  let stderrTail = "";

  function start() {
    const script = path.resolve(import.meta.dirname, "../../stt_local.py");
    proc = spawn(opts.python, ["-u", script], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", HF_HUB_DISABLE_SYMLINKS_WARNING: "1", WHISPER_LOCAL_MODEL: opts.model, ...opts.env },
      windowsHide: true,
    });
    proc.stderr.on("data", (d: Buffer) => (stderrTail = (stderrTail + d.toString()).slice(-4000)));
    const lines = createInterface({ input: proc.stdout });
    let onReady: (() => void) | null = null;
    let onFail: ((e: Error) => void) | null = null;
    ready = new Promise<void>((res, rej) => {
      onReady = res;
      onFail = rej;
    });
    lines.on("line", (line) => {
      let msg: { ready?: boolean } & Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // library noise on stdout
      }
      if (msg.ready) return onReady?.();
      waiting.shift()?.resolve(msg);
    });
    proc.on("exit", (code) => {
      const err = new SttError(`Local Whisper stopped (exit ${code}). ${stderrTail.slice(-800)}`, true);
      onFail?.(err);
      while (waiting.length) waiting.shift()!.reject(err);
      proc = null;
      ready = null;
    });
    proc.on("error", (e) => onFail?.(new SttError(`Could not start Python (${opts.python}): ${e.message}`, false)));
  }

  return {
    name: `local:${opts.model}`,
    async transcribe(file: string): Promise<SttResult> {
      if (!proc) start();
      await ready;
      const msg = (await new Promise<unknown>((resolve, reject) => {
        waiting.push({ resolve, reject });
        proc!.stdin.write(path.resolve(file) + "\n");
      })) as { ok: boolean; error?: string; segments?: Array<{ start: number; end: number; text: string }>; language?: string };
      if (!msg.ok) throw new SttError(`Local Whisper failed: ${msg.error}`, true);
      return { segments: (msg.segments ?? []).map((s) => ({ ...s, speaker: "S1" })), language: msg.language };
    },
    close() {
      proc?.kill();
    },
  };
}
