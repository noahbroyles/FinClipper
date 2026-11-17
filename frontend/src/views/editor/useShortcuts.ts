import { useEffect } from "preact/hooks";
import type { PreviewPlayer } from "./preview";
import type { PartsControls } from "./useParts";

// The editor's keyboard shortcuts (listed by ShortcutHelp and in the README).
// Start and end are those of the selected part.
export function useShortcuts(player: PreviewPlayer, timing: PartsControls): void {
    useEffect(() => {
        function onKey(event: KeyboardEvent): void {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            // The target can be the document itself, which has no closest().
            const target = event.target instanceof Element ? event.target : document.body;
            if (target.closest("input, select, textarea")) return;
            // Let the native video controls handle their own keys when focused.
            const onVideo = player.isVideo(target);
            switch (event.key) {
                case "i":
                case "I":
                    timing.setStart(player.sourceTime());
                    break;
                case "o":
                case "O":
                    timing.setEnd(player.sourceTime());
                    break;
                case "[":
                    player.seekToStart();
                    break;
                case "]":
                    player.seekToEnd();
                    break;
                case "p":
                case "P":
                    player.playSelection();
                    break;
                // Not Space: the browser already uses it to press whatever
                // button has focus and to scroll the page.
                case "k":
                case "K":
                    player.togglePlay();
                    break;
                case "ArrowLeft":
                    if (onVideo) return;
                    player.seekBy(event.shiftKey ? -1 : -5);
                    break;
                case "ArrowRight":
                    if (onVideo) return;
                    player.seekBy(event.shiftKey ? 1 : 5);
                    break;
                case ",":
                    player.seekBy(-0.1);
                    break;
                case ".":
                    player.seekBy(0.1);
                    break;
                default:
                    return;
            }
            event.preventDefault();
        }

        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [player, timing]);
}
