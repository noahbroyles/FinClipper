"""gunicorn settings for FinClipper.

Clip jobs are tracked in memory, so there must be exactly one worker
process. Concurrency comes from threads instead: preview streaming and
downloads each hold a thread for as long as they run.
"""

import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8080')}"
workers = 1
worker_class = "gthread"
threads = int(os.environ.get("GUNICORN_THREADS", "32"))
# With gthread a long running request does not trip the worker timeout, but
# keep it generous in case the worker is busy starting ffmpeg processes.
timeout = 120
graceful_timeout = 30
accesslog = "-"
errorlog = "-"
# Never preload: the job worker threads must start inside the worker process.
preload_app = False
# gunicorn 25.1+ opens a control socket for "gunicornc" in $HOME/.gunicorn by
# default. FinClipper does not use it, and when the container runs as a UID
# with no home directory (for example user: "124:125") it fails to create
# "/.gunicorn" and logs a permission error, so turn it off.
control_socket_disable = True
