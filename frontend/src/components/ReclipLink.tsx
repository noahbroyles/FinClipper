import { navigate } from "../lib/router";

interface Props {
    // The video the clip was cut from, and the clip.
    itemId: string;
    clipId: string;
}

// Opens the editor for a clip's video with that clip's settings filled in,
// to make a changed copy. Works for the user's own clips and for other
// users' public clips.
export function ReclipLink({ itemId, clipId }: Props) {
    const href = `#/item/${itemId}?${new URLSearchParams({ reclip: clipId })}`;
    return (
        <a
            class="btn small"
            href={href}
            title="Open the editor with this clip's settings, to make a changed copy"
            onClick={(event) => {
                // navigate() also restarts the editor when it is already
                // showing this re-clip, which a plain link would not.
                event.preventDefault();
                navigate(href);
            }}
        >
            Re-clip
        </a>
    );
}
