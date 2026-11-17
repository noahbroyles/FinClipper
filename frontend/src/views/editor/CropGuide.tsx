import type { RefObject } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";

interface Props {
    // The preview's <video> element, which the guide is drawn over.
    videoRef: RefObject<HTMLVideoElement | null>;
    // Where the crop sits: 0 is the left edge, 1 the right edge.
    cropX: number;
}

// Sizes in CSS pixels: the <video> element, and the picture it shows.
interface Measurements {
    boxW: number;
    boxH: number;
    sourceW: number;
    sourceH: number;
}

// Outline of the 9:16 area a vertical crop keeps, drawn over the preview
// with the rest dimmed. (Its CSS makes it ignore the pointer, so the video
// controls underneath keep working.)
export function CropGuide({ videoRef, cropX }: Props) {
    const [size, setSize] = useState<Measurements | null>(null);

    useLayoutEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const measure = () =>
            setSize({
                boxW: video.clientWidth,
                boxH: video.clientHeight,
                // 16:9 until the stream has loaded.
                sourceW: video.videoWidth || 16,
                sourceH: video.videoHeight || 9,
            });
        measure();
        video.addEventListener("loadedmetadata", measure);
        // The player resizes with the window and the layout.
        const observer = new ResizeObserver(measure);
        observer.observe(video);
        return () => {
            video.removeEventListener("loadedmetadata", measure);
            observer.disconnect();
        };
    }, []);

    if (!size) return null;

    // Where the picture is drawn inside the video element, which keeps the
    // picture's shape and centres it.
    const scale = Math.min(size.boxW / size.sourceW, size.boxH / size.sourceH);
    const picW = size.sourceW * scale;
    const picH = size.sourceH * scale;
    // Same as the crop filter in media.py: the largest 9:16 area, placed
    // by cropX, and centred vertically in taller pictures.
    const cropW = Math.min(picW, (picH * 9) / 16);
    const cropH = Math.min(picH, (picW * 16) / 9);

    return (
        <div
            class="crop-guide"
            style={{
                left: `${(size.boxW - picW) / 2}px`,
                top: `${(size.boxH - picH) / 2}px`,
                width: `${picW}px`,
                height: `${picH}px`,
            }}
        >
            <div
                class="crop-window"
                style={{
                    left: `${(picW - cropW) * cropX}px`,
                    top: `${(picH - cropH) / 2}px`,
                    width: `${cropW}px`,
                    height: `${cropH}px`,
                }}
            />
        </div>
    );
}
