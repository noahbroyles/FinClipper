// Small building blocks shared by all pages.
import type { ComponentChildren } from "preact";
import type { LoadState } from "../hooks/useLoad";

export function Spinner() {
    return <div class="spinner" aria-label="Loading" />;
}

export function Notice({ error = false, children }: { error?: boolean; children: ComponentChildren }) {
    return <div class={error ? "notice error" : "notice"}>{children}</div>;
}

// What a view shows in place of its content while its data is loading, or
// when loading failed.
export function LoadStatus({ state }: { state: LoadState<unknown> }) {
    if (state.status === "error") return <Notice error>{state.message}</Notice>;
    return <Spinner />;
}

// Page title, with optional extras (item count, sort box...) beside it.
export function PageHead({ title, children }: { title: string; children?: ComponentChildren }) {
    return (
        <div class="page-head">
            <h1>{title}</h1>
            {children}
        </div>
    );
}
