# Build the web UI (Preact and TypeScript, in frontend/) with bun. The result
# is plain JavaScript that is the same for every CPU, so this stage always
# runs on the build machine's own architecture, even when the image is being
# built for another one.
FROM --platform=$BUILDPLATFORM oven/bun:1.4 AS frontend

WORKDIR /src/frontend

COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

# "bun run build" writes the bundles to ../finclipper/static/dist.
COPY frontend ./
RUN bun run build


FROM python:3.13-slim-trixie

# ffmpeg cuts the clips. tini runs as PID 1 so signals reach gunicorn and
# any stray child processes are reaped. The fonts are the ones the burned-in
# subtitle styles use (SUBTITLE_STYLES in finclipper/media.py); installing
# them also builds the system fontconfig cache that libass reads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY finclipper ./finclipper
COPY --from=frontend /src/finclipper/static/dist ./finclipper/static/dist
COPY wsgi.py gunicorn.conf.py ./

# Run as an unprivileged user. Override with "user:" in compose if your
# media or data directory needs a different UID/GID.
RUN groupadd --gid 1000 finclipper \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /app --shell /usr/sbin/nologin finclipper \
    && mkdir -p /data \
    && chown finclipper:finclipper /data
USER finclipper

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8080'), timeout=4)"]

ENTRYPOINT ["tini", "--"]
CMD ["gunicorn", "--config", "gunicorn.conf.py", "wsgi:app"]
