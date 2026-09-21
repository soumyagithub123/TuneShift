jobs: dict[str, dict] = {}


def create(job_id: str) -> None:
    jobs[job_id] = {"status": "queued", "message": "Waiting to start..."}


def update(job_id: str, status: str, message: str, **extra) -> None:
    if job_id in jobs:
        jobs[job_id].update(status=status, message=message, **extra)


def get(job_id: str) -> dict | None:
    return jobs.get(job_id)
