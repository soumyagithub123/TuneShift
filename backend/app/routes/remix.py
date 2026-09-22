from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.schemas import ExportMixRequest, InstrumentRequest
from app.services import instruments, remix
from app.services import project as project_store

router = APIRouter(prefix="/remix")


def _work(job_id: str) -> Path:
    """The folder of a finished "change instrument" job (its parts are kept there)."""
    try:
        work = project_store.job_dir(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Remix not found")
    if not (work / "swap.mid").exists():
        raise HTTPException(status_code=404, detail="Remix not found")
    return work


@router.get("/{job_id}/stem/{name}")
def get_stem(job_id: str, name: str):
    """One part of the remix (drums, bass, vocals, the original music, or the new instrument) as wav."""
    if name not in remix.STEM_NAMES:
        raise HTTPException(status_code=404, detail="Unknown part")
    path = remix.stem_path(_work(job_id), name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Part not found")
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.post("/{job_id}/instrument")
def change_instrument(job_id: str, body: InstrumentRequest):
    """Play the found notes on another instrument. Only that part is made again, which is quick."""
    work = _work(job_id)
    if not instruments.is_valid(body.instrument):
        raise HTTPException(status_code=400, detail=f"Unknown instrument '{body.instrument}'.")
    try:
        remix.render_instrument(work, body.instrument)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not play it on {body.instrument}: {e}")
    return {"instrument": body.instrument}


@router.post("/{job_id}/export")
def export_mix(job_id: str, body: ExportMixRequest):
    """Mix the parts at the given levels into an mp3."""
    work = _work(job_id)
    try:
        mixed = remix.mix_stems(work, {
            "instrument": body.music, "drums": body.drums, "bass": body.bass, "vocals": body.vocals,
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not mix the parts: {e}")
    return FileResponse(mixed, media_type="audio/mpeg", filename="New_instrument.mp3", headers={"Cache-Control": "no-store"})
