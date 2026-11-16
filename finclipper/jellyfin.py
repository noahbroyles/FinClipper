"""Small Jellyfin API client.

Only the handful of endpoints FinClipper needs are wrapped. Authentication
always uses the modern "Authorization: MediaBrowser ..." header, because the
legacy X-Emby-* headers and the api_key query parameter can be disabled on
newer Jellyfin servers.
"""

import requests
import threading
from . import __version__
from urllib.parse import quote

CLIENT_NAME = "FinClipper"
DEVICE_NAME = "FinClipper"

# requests.Session is not documented as thread safe, so each worker thread
# gets its own session (and its own connection pool).
_local = threading.local()


def _http():
    """Return the requests.Session belonging to the current thread."""
    session = getattr(_local, "session", None)
    if session is None:
        session = requests.Session()
        _local.session = session
    return session


class JellyfinError(Exception):
    """Raised when Jellyfin cannot be reached or returns an error."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class JellyfinAuthError(JellyfinError):
    """Raised when Jellyfin rejects our credentials or token (HTTP 401)."""

    def __init__(self, message="Jellyfin session expired, please sign in again"):
        super().__init__(message, status=401)


class JellyfinClient:
    """A Jellyfin client bound to one user's access token and device id."""

    def __init__(self, base_url, device_id, token=None, verify_tls=True):
        self.base_url = base_url.rstrip("/")
        self.device_id = device_id
        self.token = token
        self.verify_tls = verify_tls

    def auth_header(self):
        """Build the MediaBrowser Authorization header value.

        Jellyfin URL-decodes every value, so each one is URL-encoded here.
        """
        parts = {
            "Client": CLIENT_NAME,
            "Device": DEVICE_NAME,
            "DeviceId": self.device_id,
            "Version": __version__,
        }
        if self.token:
            parts["Token"] = self.token
        joined = ", ".join(f'{key}="{quote(value, safe="")}"' for key, value in parts.items())
        return f"MediaBrowser {joined}"

    def url(self, path):
        """Return the absolute Jellyfin URL for an API path such as /Items."""
        return f"{self.base_url}{path}"

    def request(self, method, path, params=None, json=None, stream=False, timeout=(5, 30), headers=None):
        """Send a request to Jellyfin and return the raw requests.Response.

        Raises JellyfinAuthError on 401 and JellyfinError on connection
        problems. Other HTTP status codes are left for the caller to check,
        because the streaming proxy needs to pass them through untouched.
        """
        all_headers = {"Authorization": self.auth_header()}
        if headers:
            all_headers.update(headers)
        try:
            response = _http().request(
                method,
                self.url(path),
                params=params,
                json=json,
                headers=all_headers,
                stream=stream,
                timeout=timeout,
                verify=self.verify_tls,
                # Never follow redirects: the proxy must only talk to Jellyfin.
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise JellyfinError(f"Could not reach Jellyfin: {exc.__class__.__name__}") from exc
        if response.status_code == 401:
            response.close()
            raise JellyfinAuthError()
        return response

    def get_json(self, path, params=None):
        """GET an endpoint and decode the JSON body, raising on HTTP errors."""
        response = self.request("GET", path, params=params)
        if response.status_code == 404:
            raise JellyfinError("Not found in Jellyfin", status=404)
        if response.status_code == 403:
            raise JellyfinError("Jellyfin denied access to this item", status=403)
        if not response.ok:
            raise JellyfinError(f"Jellyfin returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise JellyfinError("Jellyfin returned invalid JSON") from exc

    def public_info(self):
        """Return /System/Info/Public (server name and version), no auth needed."""
        return self.get_json("/System/Info/Public")

    def authenticate(self, username, password):
        """Log in with a username and password.

        Returns the AuthenticationResult JSON, which contains AccessToken and
        the User object (including its Policy). The token is also stored on
        this client.
        """
        try:
            response = self.request(
                "POST",
                "/Users/AuthenticateByName",
                json={"Username": username, "Pw": password},
            )
        except JellyfinAuthError as exc:
            raise JellyfinAuthError("Invalid username or password") from exc
        if not response.ok:
            raise JellyfinError(f"Jellyfin login failed with HTTP {response.status_code}")
        result = response.json()
        self.token = result["AccessToken"]
        return result

    def logout(self):
        """Revoke this client's access token on the Jellyfin server."""
        if not self.token:
            return
        try:
            self.request("POST", "/Sessions/Logout").close()
        except JellyfinError:
            # The token may already be invalid; logging out locally is enough.
            pass

    def stop_encoding(self, play_session_id):
        """Ask Jellyfin to stop the HLS transcode started for the preview player."""
        response = self.request(
            "DELETE",
            "/Videos/ActiveEncodings",
            params={"deviceId": self.device_id, "playSessionId": play_session_id},
        )
        response.close()
