// The editor's preview player.
import Hls from "hls.js";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useAnimationFrame } from "../../hooks/useAnimationFrame";
import { useLatest } from "../../hooks/useLatest";
import { api, BASE } from "../../lib/api";
import { clamp, randomHex } from "../../lib/format";
import type { Source } from "../../types";
import type { Timing } from "./timing";

interface Callbacks {
    // The clip timing as it is right now.
    timing(): Timing;
    // Show a message under the player; "" clears it.
    onError(message: string): void;
    // The video's length became known from the stream itself.
    onDuration(duration: number): void;
}

// Plays Jellyfin's own HLS stream of a video, proxied through FinClipper,
// in a <video> element.
//
// All times going in and out are source times: positions in the original
// video file, which is what the clip is cut from. See "offset" below for
// how they differ from the player's clock.
export class PreviewPlayer {
    private video: HTMLVideoElement | null = null;
    private hls: Hls | null = null;
    // Jellyfin's id for the running transcode, used to stop it.
    private playSession: string | null = null;
    private recoveredMediaError = false;
    // Player time minus source time. Jellyfin's HLS segments start the
    // video a little after the audio (the H.264 B-frame delay, usually two
    // frames), and hls.js puts the earliest sample at zero, so every frame
    // shows up slightly late on the player's clock. Correcting for it makes
    // the clip match exactly what was on screen. Measured from the first
    // fragment.
    private offset = 0;
    private offsetMeasured = false;
    // When playing the selection, pause at this time.
    private stopAt: number | null = null;

    private readonly itemId: string;
    private readonly callbacks: Callbacks;

    constructor(itemId: string, callbacks: Callbacks) {
        this.itemId = itemId;
        this.callbacks = callbacks;
    }

    // Connect to the <video> element. Returns a function that disconnects
    // again and stops the preview.
    attach(video: HTMLVideoElement): () => void {
        this.video = video;
        const onLoadedMetadata = () => {
            // Jellyfin did not report a runtime; fall back to the stream length.
            if (!this.callbacks.timing().duration && Number.isFinite(video.duration)) {
                this.callbacks.onDuration(video.duration);
            }
        };
        const onPause = () => {
            this.stopAt = null;
        };
        const onSeeking = () => {
            // A manual seek outside the selection ends "play selection" mode.
            const now = this.sourceTime();
            if (this.stopAt !== null && (now < this.callbacks.timing().start - 0.5 || now > this.stopAt)) {
                this.stopAt = null;
            }
        };
        // Stop the Jellyfin transcode when the tab is closed.
        const onPageHide = () => this.stop();

        video.addEventListener("loadedmetadata", onLoadedMetadata);
        video.addEventListener("pause", onPause);
        video.addEventListener("seeking", onSeeking);
        window.addEventListener("pagehide", onPageHide);
        return () => {
            video.removeEventListener("loadedmetadata", onLoadedMetadata);
            video.removeEventListener("pause", onPause);
            video.removeEventListener("seeking", onSeeking);
            window.removeEventListener("pagehide", onPageHide);
            this.stop();
            this.video = null;
        };
    }

    // Start playing a version of the video with the given audio track
    // (-1: Jellyfin's default), replacing whatever was playing.
    //
    // H.264/AAC is requested so every browser can play it; Jellyfin copies
    // the original streams when they already fit.
    start(source: Source, audioIndex: number, resumeAt = 0): void {
        const video = this.video;
        if (!video) return;
        this.stop();
        this.playSession = randomHex(16);
        this.recoveredMediaError = false;
        const params = new URLSearchParams({
            MediaSourceId: source.id,
            PlaySessionId: this.playSession,
            VideoCodec: "h264",
            AudioCodec: "aac",
            TranscodingMaxAudioChannels: "2",
            VideoBitRate: "10000000",
            AudioBitRate: "192000",
            MaxWidth: "1920",
            MaxHeight: "1080",
            SegmentContainer: "ts",
        });
        if (audioIndex >= 0) params.set("AudioStreamIndex", String(audioIndex));
        const url = `${BASE}api/stream/${this.itemId}/master.m3u8?${params}`;
        this.callbacks.onError("");

        if (Hls.isSupported()) {
            const hls = new Hls({ startPosition: resumeAt > 0 ? resumeAt + this.offset : -1, maxBufferLength: 30 });
            this.hls = hls;
            hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
                // The first segment starts at source time 0, so the start
                // PTS of its video is exactly the offset. Later reloads (audio
                // track changes) keep the value measured here.
                const frag = data.frag;
                if (this.offsetMeasured || frag.type !== "main" || frag.sn !== 0) return;
                const videoInfo = frag.elementaryStreams.video;
                if (!videoInfo || !Number.isFinite(videoInfo.startPTS)) return;
                this.offsetMeasured = true;
                const offset = videoInfo.startPTS - frag.start;
                // Anything over half a second is not a decoder delay; ignore it.
                if (offset > 0 && offset < 0.5) this.offset = offset;
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (!data.fatal) return;
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.recoveredMediaError) {
                    this.recoveredMediaError = true;
                    hls.recoverMediaError();
                    return;
                }
                this.callbacks.onError(
                    `The preview could not be played (${data.details}). You can still type the start and end times and create the clip.`,
                );
            });
            hls.loadSource(url);
            hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
            // Safari on iOS has no MediaSource support but plays HLS natively.
            video.src = url;
            if (resumeAt > 0) {
                video.addEventListener("loadedmetadata", () => (video.currentTime = resumeAt), { once: true });
            }
        } else {
            this.callbacks.onError("This browser cannot play the preview stream.");
        }
    }

    // Stop the player and tell Jellyfin to stop transcoding for it.
    stop(): void {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.video?.getAttribute("src")) {
            this.video.removeAttribute("src");
            this.video.load();
        }
        if (this.playSession) {
            const playSessionId = this.playSession;
            this.playSession = null;
            api("/stream/stop", { method: "POST", body: { play_session_id: playSessionId }, keepalive: true }).catch(() => {});
        }
    }

    // Current playback position.
    sourceTime(): number {
        return Math.max(0, (this.video?.currentTime ?? 0) - this.offset);
    }

    seek(time: number): void {
        if (!this.video) return;
        const limit = this.callbacks.timing().duration || this.video.duration || time;
        this.video.currentTime = clamp(time, 0, limit) + this.offset;
    }

    // Jump by a number of seconds, backwards if negative.
    seekBy(delta: number): void {
        this.seek(this.sourceTime() + delta);
    }

    seekToStart(): void {
        this.seek(this.callbacks.timing().start);
    }

    seekToEnd(): void {
        this.seek(this.callbacks.timing().end);
    }

    // Play from the clip's start and pause at its end.
    playSelection(): void {
        this.stopAt = this.callbacks.timing().end;
        this.seekToStart();
        this.video?.play().catch(() => {});
    }

    togglePlay(): void {
        if (!this.video) return;
        if (this.video.paused) this.video.play().catch(() => {});
        else this.video.pause();
    }

    setMuted(muted: boolean): void {
        if (this.video) this.video.muted = muted;
    }

    // Whether the element is the player's own <video>.
    isVideo(element: Element): boolean {
        return element === this.video;
    }

    // Called before every repaint: ends "play selection" on the exact frame
    // (timeupdate events only fire about four times a second).
    tick(): void {
        if (this.stopAt !== null && this.video && !this.video.paused && this.sourceTime() >= this.stopAt) {
            this.video.pause();
            this.stopAt = null;
        }
    }
}

export interface Preview {
    player: PreviewPlayer;
    // Goes on the <video> element the preview plays in.
    videoRef: RefObject<HTMLVideoElement | null>;
    // Why the preview is not playing, or "".
    error: string;
}

interface PreviewSetup {
    itemId: string;
    // What to play when the editor opens.
    source: Source;
    audioIndex: number;
    timingRef: RefObject<Timing>;
    // The video's length became known from the stream itself.
    onDuration(duration: number): void;
}

// A preview player for the lifetime of the editor. It starts playing the
// given version as soon as the <video> element exists; call player.start()
// to switch to another version or audio track. Leaving the editor stops
// the preview.
export function usePreview({ itemId, source, audioIndex, timingRef, onDuration }: PreviewSetup): Preview {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [error, setError] = useState("");
    const latestOnDuration = useLatest(onDuration);
    const [player] = useState(
        () =>
            new PreviewPlayer(itemId, {
                timing: () => timingRef.current,
                onError: setError,
                onDuration: (duration) => latestOnDuration.current(duration),
            }),
    );

    useEffect(() => {
        if (!videoRef.current) return;
        const detach = player.attach(videoRef.current);
        player.start(source, audioIndex);
        return detach;
    }, []);
    useAnimationFrame(() => player.tick());

    return { player, videoRef, error };
}
