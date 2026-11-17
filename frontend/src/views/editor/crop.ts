// The area of the picture a vertical "crop" clip keeps. A pure function, so
// it can be unit tested with "bun test".

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

// Mirrors the crop filter in _video_graph() in finclipper/media.py.
//
// The narrowest crop is the largest 9:16 area of the picture, which fills a
// phone screen. cropWidth widens it from there (0) to the whole width of
// the picture (1); the clip then gets black bars above and below. cropX
// places the area: 0 is the left edge, 1 the right edge. Pictures taller
// than 9:16 are cropped top and bottom instead, around the middle.
export function cropRect(pictureWidth: number, pictureHeight: number, cropX: number, cropWidth: number): Rect {
    const narrow = Math.min(pictureWidth, (pictureHeight * 9) / 16);
    const width = narrow + (pictureWidth - narrow) * cropWidth;
    const height = Math.min(pictureHeight, (pictureWidth * 16) / 9);
    return {
        left: (pictureWidth - width) * cropX,
        top: (pictureHeight - height) / 2,
        width,
        height,
    };
}
