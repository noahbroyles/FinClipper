import { useEffect, useState } from "preact/hooks";
import { classes } from "../lib/format";
import { onToast, type ToastMessage } from "../lib/toast";

// Shows the latest toast() message for a few seconds (errors a bit longer).
export function Toast() {
    const [message, setMessage] = useState<ToastMessage | null>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        let timer = 0;
        const unsubscribe = onToast((next) => {
            setMessage(next);
            setVisible(true);
            clearTimeout(timer);
            timer = window.setTimeout(() => setVisible(false), next.isError ? 6000 : 3000);
        });
        return () => {
            clearTimeout(timer);
            unsubscribe();
        };
    }, []);

    return (
        <div class={classes("toast", message?.isError && "error", !visible && "hidden")} role="status">
            {message?.text}
        </div>
    );
}
