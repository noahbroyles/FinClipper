# FinClipper

FinClipper is a small web app for cutting clips out of the movies and episodes in your Jellyfin library. You sign in with your Jellyfin account, pick a video, mark a start and end point on a preview player, and FinClipper uses ffmpeg on the server to cut that range into a file you can download.

The server is written in Python with Flask and the web UI in TypeScript with Preact. It is meant to run as a Docker container on the same machine as Jellyfin.

## Features

- Sign in with your existing Jellyfin username and password. FinClipper only shows what your Jellyfin account can see.
- Browse libraries, shows and seasons, or search across everything. Libraries and folders can be sorted by name or by date added, in either direction, and the last choice is remembered.
- Preview player with a draggable range timeline, millisecond time inputs, nudge buttons and keyboard shortcuts.
- Two clip modes:
  - **Fast** copies the original streams without re-encoding. It takes seconds and keeps full quality, but the cut has to begin on a keyframe. In MP4 output an edit list hides the extra frames, so most players still start exactly on your start point.
  - **Precise** re-encodes to H.264 and stereo AAC in an MP4 file. It is frame accurate, plays everywhere, can scale down (1080p, 720p, ...) and converts HDR to SDR.
- Choice of audio track (or no audio) and of version, for items with several versions.
- Burn in subtitles (precise mode). Text subtitles (SRT, ASS, WebVTT, including external subtitle files) can use one of four styles: classic white with an outline, white on a dark box, yellow, or serif. Picture subtitles (Blu-ray PGS, DVD, DVB) inside the video file are burned in as they are.
- Vertical 9:16 clips for phones (precise mode), at 1080×1920, 720×1280 or 540×960. The picture can be cropped at the sides (with sliders and a guide on the preview to choose how wide the kept part is and where it sits; the narrowest cut fills the screen, wider cuts keep more of the picture with black bars above and below), shown whole over a blurred copy of itself, or shown whole with black bars.
- Multi-part clips (precise mode): splice up to 20 sections of a video into one clip, in any order. "Add part" adds a section at the playhead, the list under the time controls selects, reorders and removes parts, and "Play all parts" previews them in order. In a vertical crop, each part has its own crop position and width, so the frame can follow a subject from part to part.
- Optional clip names, used in the clip list and as the download file name. Clips can be renamed later.
- Every finished clip has its own page with a player, which "Watch" opens in a new tab. The page of a public clip can be shared: the share button copies its address, which opens for anyone who can sign in and whose Jellyfin account can see the video. A signed-out visitor is asked to sign in and then lands on the clip. The page of a private clip only opens for its owner.
- "Re-clip" opens the editor with the settings a clip was made with (version, audio track, subtitles, shape, crop, every part and the name), to make a changed copy. It works on your own clips and on other users' public clips; the original clip is kept.
- Share finished clips with "Make public". They appear under "Public clips" for other signed in users, who can watch them in the browser or download them. A public clip is only listed for users whose Jellyfin account can see the video it was cut from, and watching or downloading needs the same Jellyfin download permission as making clips. The owner can make a clip private again, and administrators can take down anyone's public clip.
- Background jobs with live progress, cancel and delete. Finished clips are deleted automatically after a configurable time.
- The browser never talks to Jellyfin directly, so Jellyfin does not need to be reachable from where you use FinClipper.

## How it works

1. You log in through FinClipper, which calls Jellyfin's `/Users/AuthenticateByName`. The returned access token is stored in FinClipper's signed, HttpOnly session cookie.
2. Library browsing and artwork go through FinClipper's JSON API, which forwards the requests to Jellyfin with your token.
3. The preview player plays Jellyfin's own HLS stream, proxied through FinClipper. The proxy only forwards HLS playlist and segment requests, adds your token as a header, and strips any token from the playlists before they reach the browser. The preview timeline is corrected for the small video delay in Jellyfin's HLS segments, so the frame you see at a given time is exactly the frame the clip starts with.
4. When you create a clip, FinClipper asks Jellyfin for the item again (so stream indexes and file paths never come from the browser), then runs ffmpeg in a background worker. ffmpeg reads the original file directly from disk if it can find it, or otherwise streams the original file from Jellyfin over HTTP.
5. A multi-part clip is made in one ffmpeg run: the file is opened once per part, each seeking straight to its part, and the parts are joined before encoding, so the joins are frame accurate and the sound stays in step with the picture.
6. For burned-in text subtitles, the worker first downloads the subtitle track from Jellyfin as SRT (Jellyfin converts other text formats and caches extracted tracks), keeps the part inside the clip and writes it as an ASS file in the chosen style. Picture subtitles are read by ffmpeg straight from the video.
7. The finished clip is offered as a download named after the clip's name if you gave it one, or otherwise with a readable name such as `Show - S01E02 - Title [00.12.03-00.12.45].mp4`.

## Quick start

1. Copy `docker-compose.yml` and adjust it:
   - `JELLYFIN_URL`: how the FinClipper container reaches Jellyfin (see [Networking](#networking)).
   - The media volume: mount your media read only, ideally at the **same path** it has inside the Jellyfin container (see [Media access](#media-access)).
   - `user`: a UID:GID that can read your media and write `./data`.
2. Build and start it:

   ```sh
   docker compose up -d --build
   ```

3. Open `http://your-server:8080` and sign in with a Jellyfin account.

### Beta image

Pushes to the `beta` branch publish `ghcr.io/<owner>/finclipper:beta`, for trying changes before they reach `latest`. A beta can upgrade the clip database (`finclipper.db`) to a newer layout, and an older FinClipper refuses to start on a database from a newer one. So give the beta its own `DATA_DIR` (for example a copy of `./data`), not the one your `latest` container uses.

## Networking

FinClipper needs to reach Jellyfin over HTTP. Two common setups:

- **Shared Docker network (recommended).** Attach FinClipper to the network Jellyfin is on (find it with `docker network ls`) and set `JELLYFIN_URL=http://jellyfin:8096`, using Jellyfin's container name. The example compose file does this with an external network.
- **Through the host.** If Jellyfin uses host networking or lives in another stack, remove the `networks` section and add this to the service, then set `JELLYFIN_URL=http://host.docker.internal:8096`:

  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```

## Media access

For each clip FinClipper looks for the file Jellyfin reports, in this order:

1. If the path matches a `PATH_MAP` entry, the mapped path inside the FinClipper container.
2. The exact same path as Jellyfin reports it. This works without any configuration when media is mounted at the same path in both containers, which is the simplest setup.
3. If neither file exists and `ALLOW_STREAM_FALLBACK` is on (the default), ffmpeg streams the original file from Jellyfin over HTTP. This works without any media mount at all, but uses more network and is a little slower to start.

`PATH_MAP` example, for Jellyfin seeing `/data/movies` and `/data/tv` while FinClipper mounts them at `/media/movies` and `/media/tv`:

```
PATH_MAP=/data/movies=/media/movies,/data/tv=/media/tv
```

The log line for each clip says whether it was read from a local file or streamed from Jellyfin.

## Configuration

All settings are environment variables. Only `JELLYFIN_URL` is required.

| Variable | Default | Description |
| --- | --- | --- |
| `JELLYFIN_URL` | (required) | Base URL of Jellyfin as seen from the container, for example `http://jellyfin:8096`. |
| `JELLYFIN_VERIFY_TLS` | `true` | Set to `false` if `JELLYFIN_URL` is HTTPS with a self-signed certificate. |
| `PATH_MAP` | (empty) | Comma separated `jellyfin_path=local_path` prefix mappings. |
| `ALLOW_STREAM_FALLBACK` | `true` | Stream the original file from Jellyfin when it is not found locally. |
| `MAX_CLIP_SECONDS` | `600` | Longest allowed clip in seconds. `0` removes the limit. |
| `MAX_CONCURRENT_JOBS` | `2` | How many ffmpeg processes may run at the same time. Further jobs wait in a queue. |
| `MAX_JOBS_PER_USER` | `3` | How many queued or running clips one user may have. |
| `CLIP_RETENTION_HOURS` | `24` | Finished clips are deleted after this many hours. A clip that is made private again gets this long again, counted from then. Public clips are not affected. |
| `PUBLIC_CLIP_RETENTION_HOURS` | `0` | Public clips are deleted this many hours after they are shared. `0` keeps them until their owner makes them private or deletes them. |
| `X264_PRESET` | `veryfast` | x264 preset for precise mode. Slower presets give smaller files. |
| `X264_CRF` | `20` | x264 quality for precise mode. Lower is better quality and bigger files. |
| `REQUIRE_DOWNLOAD_PERMISSION` | `true` | Only users allowed to download media in Jellyfin (and administrators) may create clips. |
| `DATA_DIR` | `/data` | Where clips, the clip database (`finclipper.db`) and the generated secret key are stored. |
| `SECRET_KEY` | (generated) | Session signing key. If unset, a random key is generated once and saved in `DATA_DIR/secret_key`. |
| `SESSION_DAYS` | `30` | How long a login lasts. |
| `SESSION_COOKIE_SECURE` | `false` | Set to `true` when FinClipper is only served over HTTPS. |
| `TRUSTED_PROXIES` | `0` | Number of reverse proxies in front of FinClipper whose `X-Forwarded-*` headers should be trusted. |
| `PORT` | `8080` | Port gunicorn listens on inside the container. |
| `GUNICORN_THREADS` | `32` | Request threads. Each preview stream and download holds one while it runs. |

## Permissions

A clip is effectively a download, so by default FinClipper only lets a user create clips if their Jellyfin account has "Allow media downloading" enabled (or is an administrator). Users without it can still browse and preview, but the Create button is disabled. Set `REQUIRE_DOWNLOAD_PERMISSION=false` to allow everyone, and consider `MAX_CLIP_SECONDS` as the way to stop whole movies being "clipped".

Users only see their own clips, plus clips other users have made public. A public clip is only listed for users whose Jellyfin account can see the video it was cut from (library access and parental rating limits apply), and watching or downloading it needs the same download permission as creating clips. Administrators can take down anyone's public clip.

## Reverse proxy

FinClipper works behind a reverse proxy such as nginx, Caddy or Traefik:

- Set `TRUSTED_PROXIES=1` (one proxy) so client IPs and the scheme are taken from the forwarded headers.
- Set `SESSION_COOKIE_SECURE=true` if the site is HTTPS only.
- Serving under a sub path (for example `/finclipper/`) works if the proxy sends `X-Forwarded-Prefix` and `TRUSTED_PROXIES` is set.
- Disable response buffering for `/api/stream/`, `/api/clips/` and `/api/public-clips/` if your proxy buffers large responses, so preview segments and downloads start immediately.

## Keyboard shortcuts in the editor

| Key | Action |
| --- | --- |
| `I` / `O` | Set start / end at the playhead |
| `[` / `]` | Jump to start / end |
| `P` | Play the selection and stop at the end |
| `K` | Play / pause |
| `←` / `→` | Back / forward 5 seconds (1 second with `Shift`) |
| `,` / `.` | Back / forward 0.1 seconds |

## Security notes

- The Jellyfin token is kept in FinClipper's session cookie. The cookie is HttpOnly (page scripts cannot read it) and signed (it cannot be tampered with), but it is not encrypted, so treat it like a password: anyone who copies the cookie can use the token. Signing out of FinClipper revokes the token in Jellyfin. The token is never placed in URLs, is removed from proxied playlists and is redacted from logs.
- Each login gets its own Jellyfin device id, so signing in to FinClipper never signs you out of other FinClipper sessions. Signing out revokes the token in Jellyfin.
- API requests that change state must be `application/json`, which browsers will not send cross site without CORS (FinClipper never allows CORS). Session cookies are `SameSite=Lax`.
- The HLS proxy only forwards `master.m3u8`, `main.m3u8` and `hls1/...` segment paths under `/Videos/{id}/`, so it cannot be used to reach other Jellyfin endpoints.
- Media can be mounted read only. ffmpeg runs with `nice` so clipping does not starve Jellyfin playback.

## Limitations

- Clips are stored in a SQLite database in `DATA_DIR` and survive restarts, as do login sessions. The job queue and running ffmpeg processes are kept in memory, so the app must run as a single gunicorn worker (the included `gunicorn.conf.py` does this), and clips that were queued or being made when the container stopped are marked as failed and have to be created again.
- DVD and Blu-ray folders and ISO images are not supported, only regular video files.
- External audio files (separate `.mka`/`.ac3` next to the video) cannot be selected, only audio tracks inside the video file.
- Multi-part clips are always re-encoded (precise mode), all parts come from the same video and version, and parts are joined with plain cuts (no fades). The preview pauses briefly when "Play all parts" jumps between parts; the finished clip does not. Where a part does not start exactly on a frame, the last frame before the join can be held for one extra frame.
- Subtitles can only be burned in (precise mode), not added as a separate track. The preview player does not show them.
- Picture subtitles (PGS, DVD, DVB) must be inside the video file, and the subtitle styles only apply to text subtitles. In a vertical crop, picture subtitles are scaled down to the frame width so whole lines stay visible.
- Styled ASS subtitles (common for anime) lose their own styling and positioning: they are converted to plain text and drawn in the chosen style.
- HDR to SDR conversion handles HDR10 and HLG. Dolby Vision profile 5 files (without an HDR10 base layer) will have wrong colors in precise mode.
- The preview uses Jellyfin's transcoder, with the same CPU cost as watching the video in the Jellyfin web app. When the video is already H.264 at up to 1080p and 10 Mbps, Jellyfin just repackages it.

## Development

Requires Python 3.12 or newer, ffmpeg on the `PATH`, and [bun](https://bun.sh) to build the web UI. (The Docker image builds the web UI itself, so bun is only needed for development.)

The web UI lives in `frontend/` and is bundled into `finclipper/static/dist/`, which is not kept in git. Build it once before starting the server:

```sh
cd frontend
bun install
bun run build
```

Then start the server:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
JELLYFIN_URL=http://localhost:8096 DATA_DIR=./data .venv/bin/flask --app wsgi run --debug --port 8080
```

While working on the web UI, run `bun run dev` in `frontend/` instead of `bun run build`. It rebuilds the bundles whenever a source file changes (unminified, with source maps); reload the page to see the change.

Run the server tests (the ffmpeg integration tests are skipped if ffmpeg is not installed):

```sh
.venv/bin/python -m unittest discover -s tests -v
```

Check and test the web UI, from `frontend/`. `bun run build` does not check types, so run the type check before committing (the GitHub workflow runs both, and does not build the image if either fails):

```sh
bun run typecheck
bun test
```

### Project layout

```
finclipper/
    __init__.py      app factory
    config.py        environment variable parsing
    auth.py          session handling, login decorators, CSRF guard
    jellyfin.py      minimal Jellyfin API client
    api.py           JSON API, HLS preview proxy, clip endpoints
    views.py         HTML pages and /healthz
    media.py         timestamps, stream selection, path mapping, subtitle conversion, ffmpeg command builder
    jobs.py          background ffmpeg job queue, expiry and sharing
    store.py         SQLite storage for clip records
    templates/       page shells that load the web UI
    static/          CSS, and dist/ with the built web UI
frontend/            the web UI: Preact and TypeScript, built with bun
    package.json     dependencies (preact, hls.js) and the build, dev, typecheck and test scripts
    src/
        app.tsx      entry point of the app page
        login.tsx    entry point of the sign in page
        types.ts     shapes of the API's JSON
        constants.ts values that must match media.py
        lib/         API client, hash router, formatting, toast messages
        hooks/       data loading, clip list polling and other shared hooks
        components/  top bar, item cards, clip list and other shared components
        views/       one component per page (libraries, browse, series, search, my clips, public clips)
        views/editor/  the clip editor: preview player, timeline, time controls, options panel
tests/               server unit tests and ffmpeg integration tests
Dockerfile           builds the web UI with bun, then python:3.13-slim-trixie with Debian's ffmpeg and the subtitle fonts
gunicorn.conf.py     single worker, threaded
docker-compose.yml   example deployment
```
