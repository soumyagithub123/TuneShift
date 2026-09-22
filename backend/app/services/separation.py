import sys
from pathlib import Path

from app.services.shell import run


def separate_vocals(input_wav: Path, out_dir: Path) -> Path:
    run([sys.executable, "-m", "demucs", "-n", "mdx_q", "--segment", "7", "--two-stems=vocals", str(input_wav), "-o", str(out_dir)])
    return out_dir / "mdx_q" / input_wav.stem / "vocals.wav"


def karaoke_source(work: Path) -> Path:
    """Where the full-quality part is stored for a job's voice removal."""
    return work / "karaoke" / "part.wav"


def instrumental_path(work: Path) -> Path:
    """The music-only stem that voice removal writes for this job."""
    return work / "karaoke" / "demucs" / "mdx_q" / "part" / "no_vocals.wav"


def karaoke_stem_path(work: Path, mode: str) -> Path | None:
    """Where remove_voice/vocals_only keep their separated part, for later pitch/tempo tweaks."""
    base = work / "demucs" / "mdx_q" / "trimmed"
    if mode == "vocals_only":
        return base / "vocals.wav"
    if mode == "remove_voice":
        return base / "no_vocals.wav"
    return None


def separate_stems(input_wav: Path, out_dir: Path) -> dict[str, Path]:
    """Split a song into drums, bass, other (guitars, keys, ...) and vocals."""
    run([sys.executable, "-m", "demucs", "-n", "mdx_q", "--segment", "7", str(input_wav), "-o", str(out_dir)])
    folder = out_dir / "mdx_q" / input_wav.stem
    return {name: folder / f"{name}.wav" for name in ("drums", "bass", "other", "vocals")}
