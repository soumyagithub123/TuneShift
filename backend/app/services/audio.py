from pathlib import Path

from pydub import AudioSegment

from app.services.shell import run


def trim_to_wav(input_file: str, start_sec: float, length_sec: float, out_wav: Path) -> float:
    audio = AudioSegment.from_file(input_file)
    if length_sec > 0:
        start_ms = int(start_sec * 1000)
        audio = audio[start_ms : start_ms + int(length_sec * 1000)]
    audio.export(str(out_wav), format="wav")
    return len(audio) / 1000


def _atempo_chain(factor: float) -> str:
    """ffmpeg's atempo filter only accepts 0.5-2.0 per instance; chain instances for a bigger change."""
    parts = []
    f = factor
    while f > 2.0:
        parts.append("atempo=2.0")
        f /= 2.0
    while f < 0.5:
        parts.append("atempo=0.5")
        f /= 0.5
    parts.append(f"atempo={f:.6f}")
    return ",".join(parts)


def pitch_tempo_shift(input_wav: Path, out_wav: Path, semitones: float, tempo: float, sample_rate: int = 44100) -> None:
    """Change pitch (in semitones) and speed (a multiplier) independently of each other.

    Resampling (asetrate) shifts pitch but drags speed along with it; atempo is then used to both
    cancel that speed change and apply the requested tempo, leaving pitch and tempo independent.
    """
    pitch_factor = 2 ** (semitones / 12)
    chain = f"asetrate={int(sample_rate * pitch_factor)},aresample={sample_rate},{_atempo_chain(tempo / pitch_factor)}"
    run(["ffmpeg", "-y", "-i", str(input_wav), "-filter:a", chain, str(out_wav)])
