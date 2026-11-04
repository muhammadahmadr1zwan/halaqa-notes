/** An error with a message written for the end user (the class page shows it as-is). */
export class JobError extends Error {
  constructor(
    public code: string,
    message: string,
    public permanent: boolean,
    public detail?: string,
  ) {
    super(message);
  }
}

export const UPLOAD_HINT = "You can still transcribe it by downloading the audio and choosing “Upload a recording”.";

/** Codes where the audio is unreachable but YouTube captions might still be readable. */
export const CAPTION_FALLBACK_CODES = new Set(["BOT_CHECK", "AGE_RESTRICTED", "DOWNLOAD_BLOCKED", "DOWNLOAD_FAILED"]);

export function classifyYtDlpError(stderr: string): JobError {
  const s = stderr;
  const detail = s.slice(-2000);
  const has = (re: RegExp) => re.test(s);
  if (has(/Private video|This video is private/i))
    return new JobError("PRIVATE", `This video is private, so it can't be opened. ${UPLOAD_HINT}`, true, detail);
  if (has(/members[- ]only|Join this channel/i))
    return new JobError("MEMBERS_ONLY", `This video is for channel members only. ${UPLOAD_HINT}`, true, detail);
  if (has(/live event will begin|Premieres in|is_upcoming|This live stream recording is not available/i))
    return new JobError("NOT_STARTED", "This live class hasn't finished yet. Try again after the stream ends.", true, detail);
  if (has(/confirm you.?re not a bot|Sign in to confirm you/i))
    return new JobError("BOT_CHECK", "YouTube blocked the download from our server (“confirm you're not a bot”).", true, detail);
  if (has(/confirm your age|age-restricted|inappropriate for some users/i))
    return new JobError("AGE_RESTRICTED", "YouTube requires sign-in to view this video (age restriction).", true, detail);
  if (has(/copyright|blocked it in your country|not available in your country|geo.?restrict/i))
    return new JobError("DOWNLOAD_BLOCKED", "YouTube doesn't allow this video to be downloaded from our server (copyright or region restriction).", true, detail);
  if (has(/Video unavailable|has been removed|account associated with this video has been terminated|Incomplete YouTube ID|is not a valid URL/i))
    return new JobError("UNAVAILABLE", "This video is unavailable. Please check the link.", true, detail);
  if (has(/HTTP Error 429|Too Many Requests/i))
    return new JobError("RATE_LIMITED", "YouTube is limiting requests right now. We'll retry automatically.", false, detail);
  return new JobError("DOWNLOAD_FAILED", "We couldn't download this video's audio. We'll retry automatically.", false, detail);
}

export function toJobError(e: unknown): JobError {
  if (e instanceof JobError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new JobError("INTERNAL", "Something went wrong on our side. We'll retry automatically.", false, msg.slice(0, 2000));
}
