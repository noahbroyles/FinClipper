# FinClipper

FinClipper is a small web app for cutting clips out of the movies and episodes in your Jellyfin library. You sign in with your Jellyfin account, pick a video, mark a start and end point on a preview player, and FinClipper uses ffmpeg on the server to cut that range into a file you can download.

It is written in Python with Flask, and is meant to run as a Docker container on the same machine as Jellyfin.

## Features

- Sign in with your existing Jellyfin username and password. FinClipper only shows what your Jellyfin account can see.
- Browse libraries, shows and seasons, or search across everything.
- Preview player with a draggable range timeline, millisecond time inputs, nudge buttons and keyboard shortcuts.
- Two clip modes:
  - **Fast** copies the original streams without re-encoding. It takes seconds and keeps full quality, but the cut has to begin on a keyframe. In MP4 output an edit list hides the extra frames, so most players still start exactly on your start point.
  - **Precise** re-encodes to H.264 and stereo AAC in an MP4 file. It is frame accurate, plays everywhere, can scale down (1080p, 720p, ...) and converts HDR to SDR.
- Choice of audio track (or no audio) and of version, for items with several versions.
- Background jobs with live progress, cancel and delete. Finished clips are deleted automatically after a configurable time.
- The browser never talks to Jellyfin directly, so Jellyfin does not need to be reachable from where you use FinClipper.

## How it works

1. You log in through FinClipper, which calls Jellyfin's `/Users/AuthenticateByName`. The returned access token is stored in FinClipper's signed, HttpOnly session cookie.
2. Library browsing and artwork go through FinClipper's JSON API, which forwards the requests to Jellyfin with your token.
3. The preview player plays Jellyfin's own HLS stream, proxied through FinClipper. The proxy only forwards HLS playlist and segment requests, adds your token as a header, and strips any token from the playlists before they reach the browser. The preview timeline is corrected for the small video delay in Jellyfin's HLS segments, so the frame you see at a given time is exactly the frame the clip starts with.
4. When you create a clip, FinClipper asks Jellyfin for the item again (so stream indexes and file paths never come from the browser), then runs ffmpeg in a background worker. ffmpeg reads the original file directly from disk if it can find it, or otherwise streams the original file from Jellyfin over HTTP.
5. The finished clip is offered as a download with a readable name such as `Show - S01E02 - Title [00.12.03-00.12.45].mp4`.

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
| `CLIP_RETENTION_HOURS` | `24` | Finished clips are deleted after this many hours. |
| `X264_PRESET` | `veryfast` | x264 preset for precise mode. Slower presets give smaller files. |
| `X264_CRF` | `20` | x264 quality for precise mode. Lower is better quality and bigger files. |
| `REQUIRE_DOWNLOAD_PERMISSION` | `true` | Only users allowed to download media in Jellyfin (and administrators) may create clips. |
| `DATA_DIR` | `/data` | Where clips and the generated secret key are stored. |
| `SECRET_KEY` | (generated) | Session signing key. If unset, a random key is generated once and saved in `DATA_DIR/secret_key`. |
| `SESSION_DAYS` | `30` | How long a login lasts. |
| `SESSION_COOKIE_SECURE` | `false` | Set to `true` when FinClipper is only served over HTTPS. |
| `TRUSTED_PROXIES` | `0` | Number of reverse proxies in front of FinClipper whose `X-Forwarded-*` headers should be trusted. |
| `PORT` | `8080` | Port gunicorn listens on inside the container. |
| `GUNICORN_THREADS` | `32` | Request threads. Each preview stream and download holds one while it runs. |

## Permissions

A clip is effectively a download, so by default FinClipper only lets a user create clips if their Jellyfin account has "Allow media downloading" enabled (or is an administrator). Users without it can still browse and preview, but the Create button is disabled. Set `REQUIRE_DOWNLOAD_PERMISSION=false` to allow everyone, and consider `MAX_CLIP_SECONDS` as the way to stop whole movies being "clipped".

Users only ever see and download their own clips.

## Reverse proxy

FinClipper works behind a reverse proxy such as nginx, Caddy or Traefik:

- Set `TRUSTED_PROXIES=1` (one proxy) so client IPs and the scheme are taken from the forwarded headers.
- Set `SESSION_COOKIE_SECURE=true` if the site is HTTPS only.
- Serving under a sub path (for example `/finclipper/`) works if the proxy sends `X-Forwarded-Prefix` and `TRUSTED_PROXIES` is set.
- Disable response buffering for `/api/stream/` and `/api/clips/` if your proxy buffers large responses, so preview segments and downloads start immediately.

## Keyboard shortcuts in the editor

| Key | Action |
| --- | --- |
| `I` / `O` | Set start / end at the playhead |
| `[` / `]` | Jump to start / end |
| `P` | Play the selection and stop at the end |
| `Space` | Play / pause |
| `←` / `→` | Back / forward 5 seconds (1 second with `Shift`) |
| `,` / `.` | Back / forward 0.1 seconds |

## Security notes

- The Jellyfin token is kept in FinClipper's session cookie. The cookie is HttpOnly (page scripts cannot read it) and signed (it cannot be tampered with), but it is not encrypted, so treat it like a password: anyone who copies the cookie can use the token. Signing out of FinClipper revokes the token in Jellyfin. The token is never placed in URLs, is removed from proxied playlists and is redacted from logs.
- Each login gets its own Jellyfin device id, so signing in to FinClipper never signs you out of other FinClipper sessions. Signing out revokes the token in Jellyfin.
- API requests that change state must be `application/json`, which browsers will not send cross site without CORS (FinClipper never allows CORS). Session cookies are `SameSite=Lax`.
- The HLS proxy only forwards `master.m3u8`, `main.m3u8` and `hls1/...` segment paths under `/Videos/{id}/`, so it cannot be used to reach other Jellyfin endpoints.
- Media can be mounted read only. ffmpeg runs with `nice` so clipping does not starve Jellyfin playback.

## Limitations

- Jobs are kept in memory, so the app must run as a single gunicorn worker (the included `gunicorn.conf.py` does this). Restarting the container forgets all jobs and deletes their files. Login sessions survive restarts.
- DVD and Blu-ray folders and ISO images are not supported, only regular video files.
- External audio files (separate `.mka`/`.ac3` next to the video) cannot be selected, only audio tracks inside the video file.
- Subtitles are not included or burned in.
- HDR to SDR conversion handles HDR10 and HLG. Dolby Vision profile 5 files (without an HDR10 base layer) will have wrong colors in precise mode.
- The preview uses Jellyfin's transcoder, with the same CPU cost as watching the video in the Jellyfin web app. When the video is already H.264 at up to 1080p and 10 Mbps, Jellyfin just repackages it.

## Development

Requires Python 3.12 or newer and ffmpeg on the `PATH`.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
JELLYFIN_URL=http://localhost:8096 DATA_DIR=./data .venv/bin/flask --app wsgi run --debug --port 8080
```

Run the tests (the ffmpeg integration tests are skipped if ffmpeg is not installed):

```sh
.venv/bin/python -m unittest discover -s tests -v
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
    media.py         timestamps, stream selection, path mapping, ffmpeg command builder
    jobs.py          background ffmpeg job queue
    templates/       base, login and app pages
    static/          CSS, JavaScript (no build step) and a vendored copy of hls.js 1.7.4
tests/               unit tests and ffmpeg integration tests
Dockerfile           python:3.13-slim-trixie with Debian's ffmpeg
gunicorn.conf.py     single worker, threaded
docker-compose.yml   example deployment
```
