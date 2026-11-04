# Free transcription worker (local Whisper + yt-dlp) for any always-on Linux machine / NAS / VPS.
# Build from the repo root:  docker build -t halaqa-worker .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/requirements.txt worker/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r worker/requirements.txt
# Bake the Whisper model into the image so restarts don't re-download it.
RUN /opt/venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')"

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY worker/package.json worker/
COPY web/package.json web/
RUN npm ci --omit=dev -w worker -w shared --include-workspace-root=false && npm cache clean --force

COPY tsconfig.base.json ./
COPY shared shared
COPY worker worker

ENV NODE_ENV=production \
    WORK_DIR=/tmp/halaqa \
    PYTHON_PATH=/opt/venv/bin/python \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    FFMPEG_PATH=ffmpeg

# YouTube changes often: update yt-dlp on every start.
CMD ["sh", "-c", "/opt/venv/bin/pip install -q -U 'yt-dlp[default]' >/dev/null 2>&1 || true; exec node --import tsx worker/src/index.ts"]
