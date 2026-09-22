"""Turn a song's singer into a chosen "character" voice, keeping the music underneath.

Pitch is shifted with a simple resample (like `audio.pitch_tempo_shift`), which moves the voice's
formants along with it - that's what makes a big upward shift sound like a chipmunk and a big
downward shift sound like a giant. Each character then adds its own texture (echo, EQ, tremolo...)
on top to tell them apart.
"""
import shutil
from pathlib import Path
from typing import Callable

from pydub import AudioSegment, effects

from app.config import OUTPUT_DIR
from app.services import audio, separation
from app.services.shell import run

SAMPLE_RATE = 44100
MAX_GAIN_DB = 12

# id -> (display name, pitch shift in semitones, extra ffmpeg filter chain for texture)
CHARACTERS = [
    {"id": "chipmunk", "name": "Chipmunk", "semitones": 7, "filters": "highpass=f=300"},
    {"id": "giant", "name": "Giant", "semitones": -8, "filters": "lowpass=f=3500,equalizer=f=100:t=q:w=1:g=6"},
    {"id": "robot", "name": "Robot", "semitones": -1, "filters": "highpass=f=250,lowpass=f=3800,equalizer=f=1500:t=q:w=2:g=8,tremolo=f=28:d=0.6"},
    {"id": "demon", "name": "Demon", "semitones": -7, "filters": "aecho=0.8:0.6:40|80:0.4|0.3,equalizer=f=120:t=q:w=1:g=6,lowpass=f=5000"},
    {"id": "ghost", "name": "Ghost", "semitones": -3, "filters": "aecho=0.85:0.75:600|900:0.5|0.35,highpass=f=500,vibrato=f=4:d=0.3"},
    {"id": "alien", "name": "Alien", "semitones": 4, "filters": "chorus=0.7:0.9:55:0.4:0.25:2,vibrato=f=6:d=0.3"},
    {"id": "kid", "name": "Kid", "semitones": 4, "filters": "highpass=f=250"},
    {"id": "old_man", "name": "Old man", "semitones": -3, "filters": "vibrato=f=5:d=0.2,lowpass=f=4000,equalizer=f=2500:t=q:w=1:g=-4"},
    {"id": "fairy", "name": "Fairy", "semitones": 9, "filters": "aecho=0.6:0.4:60|90:0.2|0.15,highpass=f=500"},
]

_BY_ID = {c["id"]: c for c in CHARACTERS}


def is_valid(character_id: str) -> bool:
    return character_id in _BY_ID


def _load(path: Path) -> AudioSegment:
    return AudioSegment.from_file(str(path)).set_frame_rate(SAMPLE_RATE).set_channels(2)


def _gain_to_match(seg: AudioSegment, reference: AudioSegment) -> float:
    """dB to add to `seg` so it is about as loud as `reference` (the voice it replaces)."""
    if seg.dBFS == float("-inf") or reference.dBFS == float("-inf"):
        return 0.0
    return max(-MAX_GAIN_DB, min(MAX_GAIN_DB, reference.dBFS - seg.dBFS))


def convert_voice(
    trimmed: Path,
    work: Path,
    character: str,
    job_id: str,
    on_status: Callable[[str], None],
) -> Path:
    """Turn the singer's voice into `character` and mix it back with the original music."""
    if not is_valid(character):
        raise ValueError(f"Unknown character '{character}'.")
    info = _BY_ID[character]

    on_status("Separating vocals (this takes a while)...")
    vocals = separation.separate_vocals(trimmed, work / "demucs")
    instrumental = vocals.parent / "no_vocals.wav"

    on_status(f"Turning the voice into {info['name']}...")
    pitched = work / "voice_pitched.wav"
    audio.pitch_tempo_shift(vocals, pitched, info["semitones"], 1.0, SAMPLE_RATE)

    styled = work / "voice_styled.wav"
    run(["ffmpeg", "-y", "-i", str(pitched), "-filter:a", info["filters"], str(styled)])

    on_status("Mixing with the music...")
    target_ms = len(AudioSegment.from_file(str(trimmed)))
    voice_seg = _load(styled)
    voice_seg = voice_seg.apply_gain(_gain_to_match(voice_seg, _load(vocals)))[:target_ms]
    if len(voice_seg) < target_ms:
        voice_seg += AudioSegment.silent(target_ms - len(voice_seg), frame_rate=SAMPLE_RATE).set_channels(2)
    music_seg = _load(instrumental)[:target_ms]

    mix = music_seg.overlay(voice_seg)
    out = OUTPUT_DIR / f"{job_id}.mp3"
    effects.normalize(mix, headroom=1.0).export(str(out), format="mp3")
    return out
