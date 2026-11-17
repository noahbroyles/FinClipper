import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { BASE } from "../lib/api";
import { errorMessage } from "../lib/format";

// The sign in form. Posts the credentials as JSON to /api/login.
export function LoginPage() {
    const [intro, setIntro] = useState("Sign in with your Jellyfin account");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    // The fields are read when the form is submitted rather than tracked
    // as state, so values filled in by a password manager are picked up.
    const username = useRef<HTMLInputElement>(null);
    const password = useRef<HTMLInputElement>(null);

    useLayoutEffect(() => username.current?.focus(), []);

    useEffect(() => {
        // Show which Jellyfin server the user is signing in to.
        fetch(`${BASE}api/server`)
            .then((response) => (response.ok ? response.json() : null))
            .then((info: { name?: string } | null) => {
                if (info?.name) setIntro(`Sign in with your account on ${info.name}`);
            })
            .catch(() => setError("Jellyfin is not reachable right now."));
    }, []);

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        setBusy(true);
        try {
            const response = await fetch(`${BASE}api/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: username.current?.value ?? "",
                    password: password.current?.value ?? "",
                }),
            });
            const data: { error?: string } = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `Sign in failed (${response.status})`);
            window.location.href = BASE;
        } catch (cause) {
            setError(errorMessage(cause));
            setBusy(false);
        }
    }

    return (
        <div class="login-wrap">
            <form class="login-card" autocomplete="on" onSubmit={submit}>
                <div class="brand">
                    <img src={`${BASE}static/favicon.svg`} alt="" />
                    <span>FinClipper</span>
                </div>
                <p class="muted">{intro}</p>
                <label class="field">
                    <span>Username</span>
                    <input ref={username} type="text" name="username" autocomplete="username" required />
                </label>
                <label class="field">
                    <span>Password</span>
                    <input ref={password} type="password" name="password" autocomplete="current-password" />
                </label>
                <button class="btn primary" type="submit" disabled={busy}>
                    Sign in
                </button>
                <div class="login-error" role="alert">
                    {error}
                </div>
            </form>
        </div>
    );
}
