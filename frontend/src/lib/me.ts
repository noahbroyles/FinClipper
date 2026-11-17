import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Me } from "../types";

// The signed in user, loaded once by App before any view is shown.
export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
    const me = useContext(MeContext);
    if (!me) throw new Error("useMe() was called outside of MeContext");
    return me;
}

// How long public clips last, from PUBLIC_CLIP_RETENTION_HOURS (0 means
// until they are made private). "{hours}" in the second text is replaced.
export function publicRetentionText(me: Me, forever: string, limited: string): string {
    const hours = me.public_clip_retention_hours;
    return hours ? limited.replace("{hours}", String(hours)) : forever;
}
