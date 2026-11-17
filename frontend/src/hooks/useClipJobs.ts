import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../lib/api";
import type { Job } from "../types";

export function isActive(job: Job): boolean {
    return job.status === "queued" || job.status === "running";
}

export interface ClipJobs {
    jobs: Job[];
    // False until the first load has finished (or failed).
    loaded: boolean;
    // Fetch the list again now.
    refresh(): Promise<void>;
    // Put a newly created clip at the top of the list.
    add(job: Job): void;
    // Swap in a newer copy of a clip already in the list.
    replace(job: Job): void;
}

// The signed in user's clips, kept up to date: all of them, or with an
// item id only the ones cut from that video. Polls once a second while any
// clip is queued or running, and stops when everything is finished.
export function useClipJobs(itemId: string | null): ClipJobs {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [loaded, setLoaded] = useState(false);
    // The timer and the list as the polling code sees it. They live outside
    // of render state because the poll callbacks outlast any one render.
    const live = useRef({ jobs: [] as Job[], timer: 0, mounted: false }).current;

    const actions = useMemo(() => {
        function schedule(delay = 1000): void {
            clearTimeout(live.timer);
            if (live.mounted && live.jobs.some(isActive)) live.timer = window.setTimeout(refresh, delay);
        }

        function update(next: Job[]): void {
            live.jobs = next;
            setJobs(next);
            schedule();
        }

        async function refresh(): Promise<void> {
            try {
                const params = itemId ? `?${new URLSearchParams({ item_id: itemId })}` : "";
                const data = await api<{ items: Job[] }>(`/clips${params}`);
                // Left the page while waiting: do not start polling again.
                if (live.mounted) update(data.items);
            } catch {
                // Keep the last known state and retry a little later.
                schedule(3000);
            }
            if (live.mounted) setLoaded(true);
        }

        return {
            refresh,
            add: (job: Job) => update([job, ...live.jobs]),
            replace: (job: Job) => update(live.jobs.map((other) => (other.id === job.id ? job : other))),
        };
    }, [itemId]);

    useEffect(() => {
        live.mounted = true;
        void actions.refresh();
        return () => {
            live.mounted = false;
            clearTimeout(live.timer);
        };
    }, [actions]);

    return { jobs, loaded, ...actions };
}
