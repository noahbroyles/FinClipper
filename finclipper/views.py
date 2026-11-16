"""HTML pages. The app itself is a single page driven by static/js/app.js."""

from .auth import is_logged_in, login_required_page
from flask import Blueprint, redirect, render_template, url_for

views = Blueprint("views", __name__)


@views.get("/")
@login_required_page
def index():
    return render_template("app.html")


@views.get("/login")
def login():
    if is_logged_in():
        return redirect(url_for("views.index"))
    return render_template("login.html")


@views.get("/healthz")
def healthz():
    """Liveness check used by the Docker HEALTHCHECK."""
    return {"status": "ok"}
