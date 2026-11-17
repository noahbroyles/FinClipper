// Shapes of the JSON the FinClipper API returns (see finclipper/api.py).

// An entry in a list view: a library, folder, series, season or video.
export interface Item {
    id: string;
    name: string;
    type: string | null;
    is_folder: boolean;
    collection_type: string | null;
    year: number | null;
    series_id: string | null;
    series_name: string | null;
    season: number | null;
    episode: number | null;
    runtime: number | null;
    image_tag: string | null;
    aspect: number | null;
}

export interface ItemList {
    items: Item[];
    total: number;
}

export interface VideoStream {
    index: number;
    codec: string | null;
    width: number | null;
    height: number | null;
    range: string | null;
    title: string | null;
}

export interface AudioTrack {
    index: number;
    title: string;
    codec: string | null;
    channels: number | null;
    language: string | null;
}

export interface SubtitleTrack {
    index: number;
    title: string;
    // "text" subtitles can be styled; "bitmap" (picture) ones keep their look.
    kind: "text" | "bitmap";
}

// One version of a video (a Jellyfin media source).
export interface Source {
    id: string;
    name: string;
    container: string | null;
    duration: number | null;
    video: VideoStream | null;
    audio: AudioTrack[];
    default_audio: number | null;
    subtitles: SubtitleTrack[];
    // Why this version cannot be clipped, or null if it can.
    problem: string | null;
}

export interface ItemDetails extends Item {
    title: string;
    // Why this item cannot be clipped, or null if it can.
    problem: string | null;
    sources: Source[];
}

// One of the time ranges a clip is spliced from, in seconds of the video.
export interface ClipRange {
    start: number;
    end: number;
}

// The choices a clip was made with, kept so the editor can be opened with
// them again ("Re-clip"). Stream indexes are the ones in Source.
export interface ClipSettings {
    source_id: string;
    mode: ClipMode;
    // -1: no audio.
    audio_index: number;
    subtitle_index: number | null;
    subtitle_style: string;
    layout: ClipLayout;
    fit: ClipFit;
    max_height: number;
    parts: Array<ClipRange & { crop_x: number; crop_width: number }>;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

// One of the signed in user's own clips.
export interface Job {
    id: string;
    item_id: string;
    title: string;
    name: string;
    // For a multi-part clip: the stretch of the video its parts are taken
    // from (the earliest start and the latest end). parts has every range,
    // in the order they are played.
    start: number;
    end: number;
    parts: ClipRange[];
    // Length of the finished clip (all parts together).
    duration: number;
    mode: ClipMode;
    description: string;
    filename: string;
    // Whether a browser can play the finished clip (MP4, not MKV).
    playable: boolean;
    // null for clips made before the settings were kept.
    settings: ClipSettings | null;
    status: JobStatus;
    public: boolean;
    phase: string | null;
    progress: number;
    error: string | null;
    size: number;
    created: number;
    finished: number | null;
}

// A clip someone has shared, as other users see it.
export interface PublicClip {
    id: string;
    item_id: string;
    title: string;
    name: string;
    owner_name: string | null;
    mine: boolean;
    // For a multi-part clip: the stretch of the video its parts are taken
    // from (the earliest start and the latest end). parts has every range,
    // in the order they are played.
    start: number;
    end: number;
    parts: ClipRange[];
    // Length of the finished clip (all parts together).
    duration: number;
    description: string;
    filename: string;
    playable: boolean;
    size: number;
    shared_at: number | null;
}

export interface PublicClipList {
    items: PublicClip[];
    can_download: boolean;
}

export interface SubtitleStyle {
    id: string;
    label: string;
}

// The signed in user and the server settings the UI needs.
export interface Me {
    name: string;
    is_admin: boolean;
    can_clip: boolean;
    max_clip_seconds: number;
    // Most parts a multi-part clip may be spliced from.
    max_clip_parts: number;
    clip_retention_hours: number;
    public_clip_retention_hours: number;
    subtitle_styles: SubtitleStyle[];
}

export type ClipMode = "fast" | "precise";
export type ClipLayout = "horizontal" | "vertical";
export type ClipFit = "crop" | "blur" | "bars";
