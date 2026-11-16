// Login page: posts the credentials as JSON to /api/login.
"use strict";

(function () {
    const base = document.body.dataset.base || "/";
    const form = document.getElementById("login-form");
    const errorBox = document.getElementById("login-error");
    const serverName = document.getElementById("server-name");
    const button = form.querySelector("button");

    // Show which Jellyfin server the user is signing in to.
    fetch(base + "api/server")
        .then((response) => (response.ok ? response.json() : null))
        .then((info) => {
            if (info && info.name) {
                serverName.textContent = `Sign in with your account on ${info.name}`;
            }
        })
        .catch(() => {
            errorBox.textContent = "Jellyfin is not reachable right now.";
        });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.textContent = "";
        button.disabled = true;
        try {
            const response = await fetch(base + "api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: form.username.value,
                    password: form.password.value,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Sign in failed (${response.status})`);
            }
            window.location.href = base;
        } catch (error) {
            errorBox.textContent = error.message;
            button.disabled = false;
        }
    });
})();
