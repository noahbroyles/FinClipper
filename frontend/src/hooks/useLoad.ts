import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../lib/format";

export type LoadState<T> =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; data: T };

// Load a view's data once, when the view appears. Views are created afresh
// on every navigation (see App), so there is nothing to reload later. A
// response that arrives after the view is gone is ignored, so a slow
// response never shows up on a newer page.
export function useLoad<T>(load: () => Promise<T>): LoadState<T> {
    const [state, setState] = useState<LoadState<T>>({ status: "loading" });
    useEffect(() => {
        let current = true;
        load().then(
            (data) => {
                if (current) setState({ status: "ready", data });
            },
            (error: unknown) => {
                if (current) setState({ status: "error", message: errorMessage(error) });
            },
        );
        return () => {
            current = false;
        };
    }, []);
    return state;
}
