# Halaqa Notes — free edition

A private transcription site for long Islamic classes. Paste a YouTube link, press **Transcribe**, and come back to a clean, searchable transcript where Arabic (Quran, hadith, duas, terms) stays in Arabic script, with clickable timestamps, topic headings, side-by-side video, Word/PDF/TXT/SRT export, and study notes grounded in the class.

**Everything here runs on free tiers.** No credit card is needed.

```
 Phone / browser                 Netlify (free)                       Your computer (free)
 ───────────────                 ──────────────                       ────────────────────
 paste link / upload  ───────▶   website + API function     ◀─poll──  worker: yt-dlp ▸ ffmpeg ▸ chunks
 progress, transcript ◀───────   Netlify Blobs (data, uploads) ◀─save─  Whisper on this computer (free, private)
 study notes          ───────▶                                         optional free AI: Gemini / Groq
```

| Piece | Free option used | Notes |
|---|---|---|
| Website + API + storage | **Netlify** free plan (Functions + Blobs) | One password login. No database signup. |
| Speech-to-text | **Whisper `large-v3-turbo` running locally** (faster-whisper) | No key, no quota; audio never leaves your computer. About 2.3× real time on an 8-core laptop CPU. |
| Speech-to-text (alt) | **Groq** free API (`whisper-large-v3`) | Free key; roughly 8 audio-hours/day and 2 audio-hours/hour on the free tier. The worker waits out the hourly limit. |
| AI polish + study notes | **Google Gemini** free API (default if a key is set), **Groq** free API, or **GitHub Models** | Free keys, no card. Without one, transcripts are still produced (Whisper adds punctuation); only the polish and study notes are skipped. |
| YouTube download | **yt-dlp** on your computer | Home internet is rarely blocked by YouTube, unlike cloud servers. |
| Paid (optional) | ElevenLabs Scribe, Claude | Set `STT_PROVIDER=elevenlabs` / `ANTHROPIC_API_KEY` if you ever want them. |

### Why the worker runs on your own computer
Free cloud hosts either have too little CPU/RAM for Whisper, sleep when idle, get blocked by YouTube, or (GitHub Actions) don't allow being used as a general backend under their terms. An always-on home PC is free, private, and YouTube-friendly. **The PC needs to be on while a class is processing**; finished transcripts are stored on Netlify and readable anytime from any device.

---

## Accuracy

Measured on a real tafsir lecture (5 minutes with an Arabic opening sermon, a hadith in Arabic, and English explanation) on an i9 laptop CPU:

| Whisper setting | Speed | Result |
|---|---|---|
| **beam search (used)** | 2.3× real time | Kept the full Arabic hadith in Arabic script; English accurate |
| greedy | 2.9× | Dropped the Arabic hadith entirely |
| batched | 3.2× | Invented Arabic text that wasn't said |

So the default favours completeness over speed. Other safeguards:
- `multilingual=True` re-detects the language for each segment, so English↔Arabic switching works. Voice-activity filtering stops Whisper inventing text during silences.
- The AI polish edits segments by id and can't merge, move, or delete them. Every edit passes a **guard** ([worker/src/refineGuard.ts](worker/src/refineGuard.ts)): edits that add English words, add a negation, drop speech, or add more Arabic than the transliteration they replace (e.g. "completing" a verse) are rejected, and the original wording is kept.
- Study notes are told to use only the transcript and cite `[HH:MM:SS]`. On small free context windows they use map-reduce (notes per part, then combined), so 6–8 hour classes still fit.

## Reliability for long classes
- Audio is split into about 20-minute chunks **at natural pauses**; each finished chunk is saved immediately.
- If the PC restarts or a step fails, the next run **resumes** where it stopped. Automatic retries happen after 1, 5, 15, 30 and 60 minutes.
- Pasting the same link again opens the existing class; re-uploading the same file does the same.
- When the free AI quota runs out, the transcript is still saved (unpolished parts keep Whisper's text), and study notes retry later.
- If YouTube blocks the audio, the worker falls back to the video's captions (with a lower-accuracy banner) or asks for an upload.

---

## Set up your own copy (about 20 minutes)

### 1. Website on Netlify
1. Fork or push this repo to your GitHub, then in Netlify choose **Add new project → Import from Git** and pick the repo. Build settings come from [netlify.toml](netlify.toml).
2. **Project configuration → Environment variables**:
   - `APP_PASSWORD`: the password your mom will use
   - `SESSION_SECRET`: any long random string
   - `WORKER_SECRET`: another long random string (also goes in the worker's `.env`)
3. Deploy. Note the site URL.

### 2. Worker on an always-on Windows PC
Requires Node.js 22+ and Python 3.10+.
```powershell
git clone <your repo> halaqa-notes; cd halaqa-notes
powershell -ExecutionPolicy Bypass -File scripts\setup-worker.ps1   # installs Whisper, yt-dlp, model (~1.6 GB)
notepad .env      # set API_URL=https://<your-site>.netlify.app and WORKER_SECRET
start-worker.cmd  # keep this window open (minimised is fine)
```
To start it automatically, put a shortcut to `start-worker.cmd` in `shell:startup`.
Linux, Mac, or a NAS: `docker compose up -d --build` (see [Dockerfile](Dockerfile)), or `npm ci && npm run worker` with `ffmpeg`, Python, and `pip install -r worker/requirements.txt`.

### 3. Free AI polish & study notes (recommended, 2 minutes)
- Gemini: <https://aistudio.google.com/apikey> → **Create API key** → put it in `.env` as `GEMINI_API_KEY=...`
- or Groq: <https://console.groq.com/keys> → `GROQ_API_KEY=...` (this also lets you use `STT_PROVIDER=groq` for faster transcription)

Restart the worker. Note: free-tier AI providers may use your inputs to improve their models. If that matters for a class, leave the keys empty (Whisper itself is fully local).

---

## Using it (for Mom)
1. In the YouTube app: **Share → Copy link**.
2. Open the site, tap **Paste**, then **Transcribe**.
3. You can close the page. The class appears in **Your classes** with a progress bar; a 6-hour class takes about 2.5–3 hours on the free setup.
4. Tap any **▶ time** to play from there, use **A+** for bigger text, search in English or Arabic (harakat optional), use **Download** for Word, PDF, text or subtitles, and **Study notes** for a summary, notes, takeaways and an Arabic glossary.

---

## Development
```bash
npm install
npm test            # 49 tests: Arabic search, exports (RTL .docx), chunking, captions, errors,
                    # hallucination guard, free-tier map-reduce, end-to-end pipeline with real ffmpeg
npm run typecheck
npm run dev         # http://localhost:5173/demo shows a design preview with sample data
npm run eval:stt -- --audio clip.mp3 --reference clip.txt --providers local,local:large-v3,groq
```

| Path | What |
|---|---|
| `netlify/functions/api.mts` | The whole backend: login, classes, uploads, search, worker queue (Netlify Blobs) |
| `worker/src/pipeline.ts` | Fetch → normalise → chunk at pauses → transcribe → AI polish (guarded) → save |
| `worker/stt_local.py`, `worker/src/stt/` | Local Whisper, Groq, ElevenLabs |
| `worker/src/llm.ts` | Gemini / Groq / GitHub Models / Claude behind one interface, with free-tier rate-limit handling |
| `worker/src/refine.ts`, `refineGuard.ts`, `study.ts` | Cleanup prompt, anti-hallucination guard, study notes (map-reduce) |
| `shared/` | Types, Arabic utilities, timestamps, TXT/SRT/DOCX export |
| `web/` | React + TypeScript + Tailwind site |

### Known limitations
- Local Whisper has no speaker detection, so everything is labelled as the teacher. Groq's API doesn't detect speakers either; ElevenLabs (paid) does.
- Uploaded recordings are stored on Netlify only until processed. To listen along, the class page asks you to pick the file on your device.
- Netlify's free plan has a monthly credit allowance. Text transcripts are tiny, but very large uploads use bandwidth credits; YouTube links use almost none.
- PDF export uses the browser's *Save as PDF* (the only way Arabic letter shaping comes out right).
