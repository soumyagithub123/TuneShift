from pathlib import Path
from typing import Callable

from app.schemas import Project, TuneSettings
from app.services import assemble, audio, compose, instruments, lyrics, melody, reel, separation
from app.services import project as project_store
from app.config import OUTPUT_DIR
from pydub import AudioSegment, effects

# Lyrics from a short part are worth a slower vocal-separation pass (much better accuracy);
# on longer parts it would take minutes, so the mix is transcribed directly.
LYRICS_ISOLATE_MAX_SEC = 90


def run_pipeline(
    input_file: str,
    start_sec: float,
    length_sec: float,
    instrument: str,
    settings: TuneSettings,
    job_id: str,
    on_status: Callable[[str], None],
    image_path: str | None = None,
    language: str | None = "hi",
) -> Path:
    instruments.soundfont_for(instrument)
    work = project_store.job_dir(job_id)
    work.mkdir(parents=True, exist_ok=True)

    on_status("Trimming audio...")
    trimmed = work / "trimmed.wav"
    duration = audio.trim_to_wav(input_file, start_sec, length_sec, trimmed)

    if settings.mode == "lyrics":
        source = trimmed
        if settings.isolate_vocals or duration <= LYRICS_ISOLATE_MAX_SEC:
            on_status("Separating vocals (this takes a while)...")
            source = separation.separate_vocals(trimmed, work / "demucs")
        on_status("Finding lyrics timing...")
        words = lyrics.transcribe_words(source, language)
        lines = lyrics.group_lines(words, max_words=8, max_gap=0.8)
        on_status("Converting to Hinglish...")
        lyrics.save_lines(work, lyrics.to_hinglish(lines))
        return lyrics.lyrics_path(work)

    on_status("Separating vocals (this takes a while)...")
    vocals = separation.separate_vocals(trimmed, work / "demucs")

    if settings.mode == "remove_voice":
        on_status("Finalizing accompaniment track...")
        no_vocals = vocals.parent / "no_vocals.wav"
        audio_seg = AudioSegment.from_file(str(no_vocals))
        out_mp3 = OUTPUT_DIR / f"{job_id}.mp3"
        effects.normalize(audio_seg, headroom=1.0).export(str(out_mp3), format="mp3")
        return out_mp3

    if settings.mode == "reel":
        no_vocals = vocals.parent / "no_vocals.wav"
        on_status("Finding lyrics timing...")
        lines = lyrics.group_lines(lyrics.transcribe_words(vocals, language))
        lyrics.save_lines(work, lines)
        return reel.render_reel(job_id, no_vocals, image_path, on_status)

    on_status("Extracting melody...")
    midi = melody.extract_midi(vocals, work)

    project = Project(
        job_id=job_id,
        duration=duration,
        instrument=instrument,
        tempo=settings.tempo,
        note_smoothing=settings.note_smoothing,
        pitch_bend=settings.pitch_bend,
        accompaniment=True,
    )
    
    on_status("AI is composing the accompaniment...")
    project.chords, project.accompaniment_style, project.composed_by = compose.compose(midi, duration)

    on_status(f"Playing on {instrument}...")
    project.version = 1
    project_store.save(project)
    return assemble.render(project)
