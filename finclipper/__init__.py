"""FinClipper: cut clips from Jellyfin videos with ffmpeg."""

__version__ = "0.1.0"


def create_app():
    """Flask application factory."""
    # Imports live here so "from . import __version__" in submodules works
    # without a circular import at package load time.
    import logging
    from .api import api
    from flask import Flask
    from pathlib import Path
    from .views import views
    from .config import Config
    from .jobs import JobManager
    from .store import ClipStore
    from werkzeug.middleware.proxy_fix import ProxyFix

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    app = Flask(__name__)
    config = Config()
    app.config.from_object(config)

    if config.TRUSTED_PROXIES:
        # Trust X-Forwarded-* headers from this many reverse proxies.
        count = config.TRUSTED_PROXIES
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=count, x_proto=count, x_host=count, x_prefix=count)

    manager = JobManager(
        clips_dir=config.CLIPS_DIR,
        store=ClipStore(config.DATABASE_PATH),
        max_concurrent=config.MAX_CONCURRENT_JOBS,
        max_per_user=config.MAX_JOBS_PER_USER,
        retention_hours=config.CLIP_RETENTION_HOURS,
        public_retention_hours=config.PUBLIC_CLIP_RETENTION_HOURS,
    )
    manager.start()
    app.extensions["finclipper_jobs"] = manager

    if not (Path(app.static_folder) / "dist" / "app.js").is_file():
        # The web UI is built from frontend/ and is not kept in git.
        app.logger.warning(
            "The web UI has not been built, so pages will be blank. Run \"bun install\" and \"bun run build\" in frontend/."
        )

    app.register_blueprint(views)
    app.register_blueprint(api)

    @app.context_processor
    def inject_version():
        # Used to bust browser caches of static files after an upgrade.
        return {"version": __version__}

    app.logger.info(
        "FinClipper %s started, Jellyfin at %s, %d path mapping(s)",
        __version__,
        config.JELLYFIN_URL,
        len(config.PATH_MAP),
    )
    return app
