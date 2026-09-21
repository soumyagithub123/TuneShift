import shutil
import uuid
import asyncio
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.config import MAX_UPLOAD_BYTES, OUTPUT_DIR, UPLOAD_DIR
from app.schemas import (
    AiEditRequest, AiEditResponse, EditOps, Instrument, JobStatus, LyricLine, Project,
    RenderReelRequest, TuneSettings,
)
from app.services import assemble, edit, instruments, llm, lyrics, reel, db, storage
from app.services import project as project_store
from app.services.pipeline import run_pipeline

router = APIRouter()

# UI value -> Whisper language code (None lets Whisper auto-detect).
LYRIC_LANGUAGES = {"hi": "hi", "en": "en", "auto": None}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024


async def _process(
    job_id: str, input_path: str, start: float, length: float, instrument: str, settings: TuneSettings,
    image_path: str | None = None, language: str | None = "hi",
):
    await db.update_job(job_id, "processing", "Starting pipeline...")

    loop = asyncio.get_running_loop()
    def sync_on_status(msg):
        asyncio.run_coroutine_threadsafe(db.update_job(job_id, "processing", msg), loop)

    try:
        result_path = await asyncio.to_thread(
            run_pipeline,
            input_path, start, length, instrument, settings, job_id,
            sync_on_status, image_path, language,
        )
        
        await db.update_job(job_id, "processing", "Uploading to cloud...")
        result_url = await storage.upload_file(result_path)
        
        await db.update_job(job_id, "completed", "Done", result_url=result_url)
    except Exception as e:
        await db.update_job(job_id, "failed", str(e))
        print(f"Job {job_id} failed: {e}")


def _get_project(job_id: str) -> Project:
    project = project_store.load(job_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _apply_and_render(project: Project, ops: EditOps) -> Project:
    try:
        updated = project_store.apply_edit(project, ops)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    updated.version += 1
    try:
        assemble.render(updated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Render failed: {e}")
    project_store.save(updated)
    return updated


@router.get("/instruments", response_model=list[Instrument])
async def list_instruments():
    return instruments.INSTRUMENTS


@router.get("/history")
async def get_history():
    return await db.get_history()


@router.post("/generate", response_model=JobStatus)
async def generate_tune(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    start: float = Form(0.0),
    length: float = Form(0.0),
    instrument: str = Form("sitar"),
    note_smoothing: bool = Form(False),
    pitch_bend: bool = Form(False),
    tempo: float = Form(1.0),
    mode: str = Form("compose"),
    language: str = Form("hi"),
    isolate_vocals: bool = Form(False),
    image: UploadFile | None = File(None),
):
    if not instruments.is_valid(instrument):
        raise HTTPException(status_code=400, detail=f"Unknown instrument '{instrument}'.")
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail=f"File too large. Max {MAX_UPLOAD_BYTES // (1024 * 1024)}MB.")
    if language not in LYRIC_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Unknown language '{language}'.")
    has_image = image is not None and bool(image.filename)
    image_ext = Path(image.filename).suffix.lower() if has_image else ""
    if has_image and image_ext not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Background must be a JPG, PNG or WEBP image.")
    if has_image and image.size is not None and image.size > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Background image too large. Max 8MB.")
    try:
        settings = TuneSettings(
            note_smoothing=note_smoothing, pitch_bend=pitch_bend, tempo=tempo, mode=mode,
            isolate_vocals=isolate_vocals,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    job_id = str(uuid.uuid4())
    input_path = UPLOAD_DIR / f"{job_id}{Path(file.filename or '').suffix}"
    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    image_path = None
    if has_image:
        image_path = str(UPLOAD_DIR / f"{job_id}_bg{image_ext}")
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(image.file, buffer)

    await db.create_job(job_id, file.filename, mode)
    background_tasks.add_task(
        _process, job_id, str(input_path), start, length, instrument, settings,
        image_path, LYRIC_LANGUAGES[language],
    )
    
    return JobStatus(job_id=job_id, status="queued", message="Job queued")


@router.get("/status/{job_id}", response_model=JobStatus)
async def get_status(job_id: str):
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobStatus(job_id=job_id, status=job["status"], message=job["message"])


@router.get("/projects/{job_id}", response_model=Project)
def get_project(job_id: str):
    return _get_project(job_id)


@router.post("/projects/{job_id}/edit", response_model=Project)
def edit_project(job_id: str, ops: EditOps):
    return _apply_and_render(_get_project(job_id), ops)


@router.post("/projects/{job_id}/ai-edit", response_model=AiEditResponse)
def ai_edit_project(job_id: str, body: AiEditRequest):
    if not llm.available():
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set in backend/.env")
    project = _get_project(job_id)
    try:
        ops, reply = edit.ai_edit(project, body.instruction)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI request failed: {e}")
    if ops == EditOps():
        return AiEditResponse(project=project, reply=reply)
    return AiEditResponse(project=_apply_and_render(project, ops), reply=reply)


@router.get("/reels/{job_id}/lyrics", response_model=list[LyricLine])
def get_reel_lyrics(job_id: str):
    try:
        lines = lyrics.load_lines(project_store.job_dir(job_id))
    except ValueError:
        lines = None
    if lines is None:
        raise HTTPException(status_code=404, detail="Reel not found")
    return lines


@router.post("/reels/{job_id}/render")
def rerender_reel(job_id: str, body: RenderReelRequest):
    try:
        work = project_store.job_dir(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Reel not found")
    if lyrics.load_lines(work) is None:
        raise HTTPException(status_code=404, detail="Reel not found")
    lyrics.save_lines(work, body.lines)
    try:
        reel.render_reel(job_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Render failed: {e}")
    return {"job_id": job_id, "status": "completed"}


@router.get("/download/{job_id}")
async def download_result(job_id: str):
    try:
        job_uuid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Result not found")
    video = OUTPUT_DIR / f"{job_uuid}.mp4"
    if video.exists():
        return FileResponse(
            video, media_type="video/mp4", filename=f"TuneShift_{job_id}.mp4",
            headers={"Cache-Control": "no-store"},
        )
    path = OUTPUT_DIR / f"{job_uuid}.mp3"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Result not ready or job failed")
    return FileResponse(
        path, media_type="audio/mpeg", filename=f"TuneShift_{job_id}.mp3",
        headers={"Cache-Control": "no-store"},
    )
