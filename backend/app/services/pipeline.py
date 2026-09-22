from pathlib import Path
from typing import Callable

from app.schemas import Project, TuneSettings
from app.services import assemble, audio, compose, instruments, lyrics, melody, reel, remix, separation, voice
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
    work = project_store.job_dir(job_id)
    work.mkdir(parents=True, exist_ok=True)
    # Only compose mode needs a soundfont — checking early for a clear error message.
    if settings.mode not in ("remove_voice", "vocals_only", "reel", "lyrics", "swap", "lofi", "voice"):
        instruments.soundfont_for(instrument)


    on_status("Trimming audio...")
    trimmed = work / "trimmed.wav"
    duration = audio.trim_to_wav(input_file, start_sec, length_sec, trimmed)

    if settings.mode == "swap":
        return remix.swap_instrument(trimmed, work, instrument, settings, job_id, on_status)
    if settings.mode == "lofi":
        return remix.lofi(trimmed, work, settings, job_id, on_status)
    if settings.mode == "voice":
        return voice.convert_voice(trimmed, work, settings.voice_character, job_id, on_status)

    if settings.mode == "lyrics":
        source = trimmed
        if settings.isolate_vocals or duration <= LYRICS_ISOLATE_MAX_SEC:
            on_status("Separating vocals (this takes a while)...")
            source = separation.separate_vocals(trimmed, work / "demucs")
        on_status("Finding lyrics timing...")
        words, _spoken = lyrics.transcribe_words(source, language)
        lines = lyrics.group_lines(words, max_words=8, max_gap=0.8)
        on_status("Converting to Hinglish...")
        lyrics.save_lines(work, lyrics.to_hinglish(lines))
        return lyrics.lyrics_path(work)

    on_status("Separating vocals (this takes a while)...")
    vocals = separation.separate_vocals(trimmed, work / "demucs")

    def _export_stem(stem_path: Path) -> Path:
        audio_seg = AudioSegment.from_file(str(stem_path))
        out_mp3 = OUTPUT_DIR / f"{job_id}.mp3"
        effects.normalize(audio_seg, headroom=1.0).export(str(out_mp3), format="mp3")
        return out_mp3

    if settings.mode == "remove_voice":
        on_status("Finalizing accompaniment track...")
        return _export_stem(vocals.parent / "no_vocals.wav")

    if settings.mode == "vocals_only":
        on_status("Finalizing vocal track...")
        return _export_stem(vocals)

    if settings.mode == "reel":
        no_vocals = vocals.parent / "no_vocals.wav"
        on_status("Finding lyrics timing...")
        lines = lyrics.group_lines(lyrics.transcribe_words(vocals, language)[0])
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
