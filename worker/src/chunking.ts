export interface Silence {
  start: number;
  end: number;
}

export interface ChunkPlan {
  idx: number;
  start: number;
  end: number;
}

/**
 * Split a recording into ~`target`-second chunks, cutting inside pauses so no word is cut in half.
 * Within ±`window` seconds of each ideal cut, the longest silence wins; otherwise we cut at the ideal point.
 */
export function planChunks(duration: number, silences: Silence[], target = 1200, window = 120): ChunkPlan[] {
  const plan: ChunkPlan[] = [];
  let pos = 0;
  while (duration - pos > target * 1.25) {
    const ideal = pos + target;
    let best: Silence | null = null;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid <= pos + 1 || Math.abs(mid - ideal) > window) continue;
      if (!best || s.end - s.start > best.end - best.start) best = s;
    }
    const cut = best ? round3((best.start + best.end) / 2) : ideal;
    plan.push({ idx: plan.length, start: pos, end: cut });
    pos = cut;
  }
  plan.push({ idx: plan.length, start: pos, end: round3(duration) });
  return plan;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Parse ffmpeg `silencedetect` stderr output. */
export function parseSilences(stderr: string): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return out;
}

/** Parse "Duration: 01:02:03.45" from ffmpeg stderr. */
export function parseFfmpegDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
