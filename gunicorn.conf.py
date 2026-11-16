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
