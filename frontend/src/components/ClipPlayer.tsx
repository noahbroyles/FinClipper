import { useEffect, useRef } from "preact/hooks";

// Inline player for a finished clip, shown under it in a clip list.
export function ClipPlayer({ src }: { src: string }) {
    const ref = useRef<HTMLVideoElement>(null);

    // A video element keeps playing (and downloading) after it is removed
    // from the page, so stop it when the player is closed or the page left.
    useEffect(() => {
        const video = ref.current;
        return () => {
            if (!video) return;
            video.pause();
            video.removeAttribute("src");
            video.load();
        };
    }, []);

    return (
        <div class="clip-player">
            <video ref={ref} controls autoplay playsInline src={src} />
        </div>
    );
}
