import sys
from pathlib import Path

from app.services.shell import run


def separate_vocals(input_wav: Path, out_dir: Path) -> Path:
    run([sys.executable, "-m", "demucs", "-n", "htdemucs", "--two-stems=vocals", str(input_wav), "-o", str(out_dir)])
    return out_dir / "htdemucs" / input_wav.stem / "vocals.wav"


def karaoke_source(work: Path) -> Path:
    """Where the full-quality part is stored for a job's voice removal."""
    return work / "karaoke" / "part.wav"


def instrumental_path(work: Path) -> Path:
    """The music-only stem that voice removal writes for this job."""
    return work / "karaoke" / "demucs" / "htdemucs" / "part" / "no_vocals.wav"
