"""WSGI entry point, used by gunicorn as "wsgi:app"."""

from finclipper import create_app

app = create_app()
