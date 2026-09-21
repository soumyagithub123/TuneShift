import uuid
from pathlib import Path

from app.config import WORK_DIR
from app.schemas import EditOps, Project
from app.services import instruments


def job_dir(job_id: str) -> Path:
    return WORK_DIR / str(uuid.UUID(job_id))


def melody_path(job_id: str) -> Path:
    return job_dir(job_id) / "melody.mid"


def load(job_id: str) -> Project | None:
    try:
        path = job_dir(job_id) / "project.json"
    except ValueError:
        return None
    if not path.exists():
        return None
    return Project.model_validate_json(path.read_text(encoding="utf-8"))


def save(project: Project) -> None:
    (job_dir(project.job_id) / "project.json").write_text(project.model_dump_json(indent=2), encoding="utf-8")


def apply_edit(project: Project, ops: EditOps) -> Project:
    if ops.instrument is not None and not instruments.is_valid(ops.instrument):
        raise ValueError(f"Unknown instrument '{ops.instrument}'.")
    data = project.model_dump()
    for field, value in ops.model_dump(exclude={"add_mute_ranges", "clear_mutes"}).items():
        if value is not None:
            data[field] = value
    if ops.clear_mutes:
        data["mute_ranges"] = []
    data["mute_ranges"] = list(data["mute_ranges"]) + [
        (min(a, b), max(a, b)) for a, b in ops.add_mute_ranges
    ]
    return Project.model_validate(data)
