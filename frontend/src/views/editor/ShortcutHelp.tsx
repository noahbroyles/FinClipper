// The line under the editor listing its keyboard shortcuts (handled by
// useShortcuts).
export function ShortcutHelp() {
    return (
        <div class="shortcuts">
            Shortcuts: <kbd>I</kbd> / <kbd>O</kbd> set start / end at the playhead, <kbd>[</kbd> / <kbd>]</kbd> jump to
            start / end, <kbd>P</kbd> play selection, <kbd>K</kbd> play / pause, <kbd>←</kbd> <kbd>→</kbd> 5 s (
            <kbd>Shift</kbd> 1 s), <kbd>,</kbd> <kbd>.</kbd> 0.1 s.
        </div>
    );
}
