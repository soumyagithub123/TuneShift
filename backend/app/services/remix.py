"""Music remixes of a trimmed song: swap the melodic part to another instrument, or make it lofi."""
import math
import shutil
from pathlib import Path
from typing import Callable

import pretty_midi
from pydub import AudioSegment, effects

from app.config import OUTPUT_DIR
from app.schemas import TuneSettings
from app.services import instruments, melody, separation
from app.services.render import render_midi
from app.services.shell import run

MIN_NOTE_SECONDS = 0.1  # the note finder also hears drums and noise as very short notes
MIN_VELOCITY = 30
MAX_GAIN_DB = 12
SAMPLE_RATE = 44100

# The parts a swapped song is made of. They are kept in the job folder, so the mix can be changed
# afterwards (drums on/off, another instrument, ...) without separating the song again.
STEM_NAMES = ("instrument", "drums", "bass", "vocals", "other")


def stem_path(work: Path, name: str) -> Path:
    if name == "instrument":
        return work / "instrument.wav"
    return work / "demucs" / "htdemucs" / "trimmed" / f"{name}.wav"


MONO_FRAME = 0.02  # seconds; resolution for picking the one loudest note at each instant


def _monophonic_reduce(notes: list[pretty_midi.Note], frame: float = MONO_FRAME):
    """Collapse overlapping notes into a single melodic line, keeping the loudest note at
    each instant. The "other" stem left after separation is often several instruments
    layered together (rhythm guitar, pads, keys...) and a polyphonic transcriber picks up
    all of them at once; without this a swapped instrument plays a wrong-sounding chord
    instead of the tune.
    """
    if not notes:
        return []
    n_frames = int(max(n.end for n in notes) / frame) + 1
    frame_pitch: list[int | None] = [None] * n_frames
    frame_vel = [0] * n_frames
    for n in notes:
        for i in range(int(n.start / frame), min(int(n.end / frame), n_frames)):
            if n.velocity > frame_vel[i]:
                frame_vel[i] = n.velocity
                frame_pitch[i] = n.pitch

    out = []
    cur_pitch, cur_start, cur_vels = None, 0.0, []
    for i, pitch in enumerate(frame_pitch + [None]):
        t = i * frame
        if pitch != cur_pitch:
            if cur_pitch is not None:
                out.append((cur_pitch, cur_start, t, int(sum(cur_vels) / len(cur_vels))))
            cur_pitch, cur_start, cur_vels = pitch, t, []
        if pitch is not None:
            cur_vels.append(frame_vel[i])
    return out


def _clean_midi(source: Path, out: Path, program: int) -> int:
    """Reduce the found notes to a single melodic line on one instrument, dropping tiny/quiet ones."""
    found = pretty_midi.PrettyMIDI(str(source))
    candidates = [
        n
        for track in found.instruments
        if not track.is_drum
        for n in track.notes
        if n.end - n.start >= MIN_NOTE_SECONDS and n.velocity >= MIN_VELOCITY
    ]
    lead = pretty_midi.Instrument(program=program, name="swap")
    for pitch, start, end, velocity in _monophonic_reduce(candidates):
        if end - start >= MIN_NOTE_SECONDS:
            lead.notes.append(pretty_midi.Note(velocity=velocity, pitch=pitch, start=start, end=end))
    cleaned = pretty_midi.PrettyMIDI()
    cleaned.instruments.append(lead)
    cleaned.write(str(out))
    return len(lead.notes)


def _gain_to_match(audio: AudioSegment, reference: AudioSegment) -> float:
    """dB to add to `audio` so it is about as loud as `reference` (the part it replaces)."""
    if audio.dBFS == float("-inf") or reference.dBFS == float("-inf"):
        return 0.0
    return max(-MAX_GAIN_DB, min(MAX_GAIN_DB, reference.dBFS - audio.dBFS))


def _load(path: Path) -> AudioSegment:
    return AudioSegment.from_file(str(path)).set_frame_rate(SAMPLE_RATE).set_channels(2)


def render_instrument(work: Path, instrument: str) -> None:
    """(Re)play the found notes on `instrument` and store them as the "instrument" part."""
    midi_file = work / "swap.mid"
    midi = pretty_midi.PrettyMIDI(str(midi_file))
    for track in midi.instruments:
        track.program = instruments.program_for(instrument)
    midi.write(str(midi_file))

    rendered = work / "swap.wav"
    render_midi(midi_file, instruments.soundfont_for(instrument), rendered)

    target_ms = len(AudioSegment.from_file(str(work / "trimmed.wav")))
    audio = _load(rendered)
    audio = audio.apply_gain(_gain_to_match(audio, _load(stem_path(work, "other"))))[:target_ms]
    if len(audio) < target_ms:
        audio += AudioSegment.silent(target_ms - len(audio), frame_rate=SAMPLE_RATE).set_channels(2)
    audio.export(str(stem_path(work, "instrument")), format="wav")


def mix_stems(work: Path, levels: dict[str, float]) -> Path:
    """Mix the parts of a swapped song at the given levels (0 = off, 1 = as it is) into an mp3."""
    base = _load(stem_path(work, "instrument"))
    mix = AudioSegment.silent(duration=len(base), frame_rate=SAMPLE_RATE).set_channels(2)
    for name in STEM_NAMES:
        level = levels.get(name, 0.0)
        if level <= 0:
            continue
        part = _load(stem_path(work, name))
        if level != 1:
            part = part.apply_gain(20 * math.log10(level))
        mix = mix.overlay(part)
    out = work / "export.mp3"
    effects.normalize(mix, headroom=1.0).export(str(out), format="mp3")
    return out


def swap_instrument(
    trimmed: Path,
    work: Path,
    instrument: str,
    settings: TuneSettings,
    job_id: str,
    on_status: Callable[[str], None],
) -> Path:
    """Replace the melodic stretch of the music (guitars, keys, ...) by `instrument`.

    The song is split into drums, bass, "other" and vocals. Only "other" is turned into notes and
    played on the new instrument; the parts stay in the job folder so the mix can be changed later.
    """
    on_status("Separating vocals (this takes a while)...")
    stems = separation.separate_stems(trimmed, work / "demucs")

    on_status("Reading the notes...")
    found = melody.extract_midi(stems["other"], work)
    if _clean_midi(found, work / "swap.mid", instruments.program_for(instrument)) == 0:
        raise ValueError("No notes could be found in the music of this part. Try another part of the song.")

    on_status(f"Playing on {instrument}...")
    render_instrument(work, instrument)

    on_status("Mixing...")
    mixed = mix_stems(work, {
        "instrument": 1.0,
        "drums": 1.0 if settings.keep_drums else 0.0,
        "bass": 1.0 if settings.keep_bass else 0.0,
        "vocals": 1.0 if settings.keep_vocals else 0.0,
    })
    out = OUTPUT_DIR / f"{job_id}.mp3"
    shutil.copyfile(mixed, out)
    return out


def lofi_graph(speed: float, vinyl: bool, reverb: bool) -> str:
    """ffmpeg filter graph: slower and lower, warm and muffled, a little tape wobble, optional room and vinyl noise."""
    chain = [
        f"aresample={SAMPLE_RATE}",
        f"asetrate={int(SAMPLE_RATE * speed)}",  # plays slower and lower, like a slowed record
        f"aresample={SAMPLE_RATE}",
        "highpass=f=70",
        "lowpass=f=4500",
        "equalizer=f=200:t=q:w=1:g=2",
        "vibrato=f=0.5:d=0.04",
        "acompressor=threshold=-18dB:ratio=3:attack=20:release=250",
    ]
    if reverb:
        chain.append("aecho=0.8:0.7:70|140:0.3|0.2")
    main = ",".join(chain)
    if vinyl:
        noise = f"anoisesrc=color=pink:amplitude=0.5:sample_rate={SAMPLE_RATE},highpass=f=1200,lowpass=f=8000,volume=0.025"
        return f"[0:a]{main}[m];{noise}[n];[m][n]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]"
    return f"[0:a]{main},alimiter=limit=0.95[out]"


def lofi(
    trimmed: Path,
    work: Path,
    settings: TuneSettings,
    job_id: str,
    on_status: Callable[[str], None],
) -> Path:
    source = trimmed
    if settings.lofi_remove_vocals:
        on_status("Separating vocals (this takes a while)...")
        source = separation.separate_vocals(trimmed, work / "demucs").parent / "no_vocals.wav"

    on_status("Adding the lofi feel...")
    out = OUTPUT_DIR / f"{job_id}.mp3"
    run([
        "ffmpeg", "-y", "-i", str(source),
        "-filter_complex", lofi_graph(settings.lofi_speed, settings.lofi_vinyl, settings.lofi_reverb),
        "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", str(out),
    ])
    return out
