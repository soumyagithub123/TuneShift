import sys
from pathlib import Path

from app.services.shell import run


def separate_vocals(input_wav: Path, out_dir: Path) -> Path:
    run([sys.executable, "-m", "demucs", "-n", "htdemucs", "--two-stems=vocals", str(input_wav), "-o", str(out_dir)])
    return out_dir / "htdemucs" / input_wav.stem / "vocals.wav"
