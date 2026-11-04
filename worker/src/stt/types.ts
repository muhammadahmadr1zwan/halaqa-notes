import type { RawSegment } from "../segmenting.ts";

export interface SttResult {
  segments: RawSegment[];
  language?: string;
}

export interface SttProvider {
  /** Stored with each chunk so mixed-provider transcripts are traceable. */
  name: string;
  transcribe(file: string): Promise<SttResult>;
}

export class SttError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export function httpError(provider: string, status: number, body: string): SttError {
  // 408/409/429 and 5xx are transient; everything else (bad key, bad request) is not.
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  return new SttError(`${provider} HTTP ${status}: ${body.slice(0, 500)}`, retryable);
}
