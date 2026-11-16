"""Session handling and login decorators.

The Jellyfin access token is kept in Flask's signed, HttpOnly session
cookie. Each login gets its own random DeviceId, because Jellyfin revokes a
user's older tokens when they log in again with the same DeviceId, which
would otherwise sign the user out in their other browsers.
"""

import uuid
import functools
from .jellyfin import JellyfinClient
from flask import current_app, jsonify, redirect, request, session, url_for


def new_device_id():
    """Random DeviceId for a fresh login."""
    return uuid.uuid4().hex


def is_logged_in():
    return bool(session.get("token") and session.get("user_id"))


def jellyfin_client():
    """Jellyfin client for the logged in user (or an anonymous one)."""
    config = current_app.config
    return JellyfinClient(
        config["JELLYFIN_URL"],
        device_id=session.get("device_id") or new_device_id(),
        token=session.get("token"),
        verify_tls=config["JELLYFIN_VERIFY_TLS"],
    )


def store_login(result, device_id):
    """Save a successful AuthenticateByName result in the session."""
    user = result.get("User") or {}
    policy = user.get("Policy") or {}
    session.clear()
    session.permanent = True
    session["token"] = result["AccessToken"]
    session["device_id"] = device_id
    session["user_id"] = user.get("Id")
    session["user_name"] = user.get("Name") or "User"
    session["is_admin"] = bool(policy.get("IsAdministrator"))
    session["can_download"] = bool(policy.get("EnableContentDownloading"))


def can_clip():
    """Whether the current user may create clips.

    A clip is effectively a download, so by default only users allowed to
    download media in Jellyfin (and administrators) may make one.
    """
    if not current_app.config["REQUIRE_DOWNLOAD_PERMISSION"]:
        return True
    return bool(session.get("is_admin") or session.get("can_download"))


def login_required_page(view):
    """Redirect anonymous visitors of HTML pages to the login page."""

    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if not is_logged_in():
            return redirect(url_for("views.login"))
        return view(*args, **kwargs)

    return wrapper


def login_required_api(view):
    """Answer 401 JSON for anonymous API calls."""

    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if not is_logged_in():
            return jsonify(error="Not signed in"), 401
        return view(*args, **kwargs)

    return wrapper


def require_json_for_writes():
    """CSRF protection for the API.

    Browsers can only send a cross-site POST with a "simple" content type
    (form or text) unless the target allows it through CORS, which we never
    do. Requiring application/json on POST therefore blocks cross-site form
    submissions. DELETE always needs a CORS preflight, so it is safe too.
    """
    if request.method == "POST" and not request.is_json:
        return jsonify(error="Expected a JSON request body"), 415
    return None
