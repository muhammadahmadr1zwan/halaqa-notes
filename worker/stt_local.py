"""
Free, private speech-to-text with faster-whisper (runs on this computer's CPU or NVIDIA GPU).

Protocol: one audio file path per line on stdin -> one JSON line on stdout.
The model is loaded once and reused for every chunk.
"""
import json
import os
import sys

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_LOCAL_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8" if DEVICE in ("auto", "cpu") else "float16")
BEAM = int(os.environ.get("WHISPER_BEAM", "5"))
# An Arabic example in the prompt nudges Whisper to write Arabic in Arabic script.
PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "An Islamic class in English. Quran verses, hadith and duas are recited in Arabic: "
    "بسم الله الرحمن الرحيم. الحمد لله رب العالمين.",
)


def main() -> None:
    model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=os.cpu_count() or 4)
    print(json.dumps({"ready": True, "model": MODEL}), flush=True)
    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
            segments, info = model.transcribe(
                path,
                multilingual=True,  # detect language per segment: English <-> Arabic switching
                beam_size=BEAM,  # beam search: greedy/batched modes dropped or invented Arabic in tests
                vad_filter=True,  # skip silence (prevents Whisper inventing text over pauses)
                condition_on_previous_text=False,  # prevents repetition loops on long audio
                initial_prompt=PROMPT,
            )
            out = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments if s.text.strip()]
            print(json.dumps({"ok": True, "segments": out, "language": info.language}, ensure_ascii=False), flush=True)
        except Exception as e:  # report and keep serving
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main()
