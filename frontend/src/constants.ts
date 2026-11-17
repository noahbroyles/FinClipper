// Values that have to match the server side in finclipper/media.py.

// Codecs that Fast mode can copy into an MP4 file. Must match MP4_VIDEO_COPY
// and MP4_AUDIO_COPY. Only used to describe the output format before the
// clip is created.
export const MP4_VIDEO_COPY = new Set(["h264", "hevc", "av1", "vp9", "mpeg4", "mpeg2video"]);
export const MP4_AUDIO_COPY = new Set(["aac", "mp3", "ac3", "eac3"]);

// Longest clip name. Must match MAX_CLIP_NAME_LENGTH.
export const CLIP_NAME_MAX = 100;

// Vertical (9:16) output sizes as [height, width]. The height is sent as
// max_height. Must match VERTICAL_SIZES.
export const VERTICAL_SIZES: ReadonlyArray<readonly [height: number, width: number]> = [
    [1920, 1080],
    [1280, 720],
    [960, 540],
];

// Maximum heights offered for horizontal clips in Precise mode (only those
// below the source height are shown). Must be in ALLOWED_HEIGHTS.
export const HORIZONTAL_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
