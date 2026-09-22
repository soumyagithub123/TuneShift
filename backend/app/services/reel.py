import shutil
from pathlib import Path
from typing import Callable

from app.config import OUTPUT_DIR
from app.schemas import LyricLine
from app.services import lyrics
from app.services import project as project_store
from app.services.shell import run

# Output sizes (width, height) the user can pick.
SIZES = {"9:16": (1080, 1920), "4:5": (1080, 1350), "1:1": (1080, 1080), "16:9": (1920, 1080)}
POSITIONS = ("top", "middle", "bottom")
STYLES = ("highlight", "plain")  # highlight: each word lights up as it is sung
DEFAULT_SIZE = SIZES["9:16"]
FONT = "DejaVu Sans"  # available on Linux (Render); covers Latin and many scripts


def _ass_time(t: float) -> str:
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_escape(text: str) -> str:
    # Braces open ASS override blocks and backslashes start escapes; neither belongs in lyrics.
    return text.replace("\\", "").replace("{", "(").replace("}", ")")


def _karaoke_text(line: LyricLine, highlight: bool = True) -> str:
    """The line's words, optionally timed so each word lights up in proportion to its length."""
    words = _ass_escape(line.text).split()
    if not words:
        return ""
    if not highlight:
        return " ".join(words)
    total_cs = max(len(words), int(round((line.end - line.start) * 100)))
    weights = [len(w) + 1 for w in words]
    scale = total_cs / sum(weights)
    return " ".join(f"{{\\kf{max(1, int(round(wt * scale)))}}}{w}" for w, wt in zip(words, weights))


def build_ass(
    lines: list[LyricLine],
    out_path: Path,
    size: tuple[int, int] = DEFAULT_SIZE,
    position: str = "middle",
    highlight: bool = True,
) -> None:
    width, height = size
    font_size = round(min(width, height) * 0.10)
    side_margin = round(width * 0.08)
    # ASS alignment: 8 = top centre, 5 = middle centre, 2 = bottom centre.
    align, margin_v = {
        "top": (8, round(height * 0.17)),
        "middle": (5, 0),
        "bottom": (2, round(height * 0.17)),
    }[position]
    # PrimaryColour is the already-sung colour, SecondaryColour the not-yet-sung one (ASS BGR order).
    primary = "&H0000D7FF" if highlight else "&H00FFFFFF"
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,{FONT},{font_size},{primary},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,{align},{side_margin},{side_margin},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = sorted((l for l in lines if l.text.strip()), key=lambda l: l.start)
    events = []
    for i, line in enumerate(lines):
        # Hold the line briefly past its last word, but never overlap the next line.
        end = line.end + 0.4
        if i + 1 < len(lines):
            end = min(end, lines[i + 1].start)
        end = max(end, line.start + 0.3)
        events.append(
            f"Dialogue: 0,{_ass_time(line.start)},{_ass_time(end)},Karaoke,,0,0,0,,{_karaoke_text(line, highlight)}"
        )
    out_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")


def _filter_path(p: Path) -> str:
    # ffmpeg filter args need forward slashes and an escaped drive colon on Windows.
    return str(p).replace("\\", "/").replace(":", "\\:")


def render_video(
    audio: Path,
    lines: list[LyricLine],
    image: Path | None,
    out_mp4: Path,
    work: Path,
    size: tuple[int, int] = DEFAULT_SIZE,
    position: str = "middle",
    highlight: bool = True,
) -> Path:
    width, height = size
    ass = work / "lyrics.ass"
    build_ass(lines, ass, size, position, highlight)

    dim = "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill"
    subs = f"subtitles='{_filter_path(ass)}'"

    if image is not None:
        cover = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1"
        )
        inputs = ["-loop", "1", "-i", str(image)]
        vf = f"{cover},{dim},{subs},format=yuv420p"
    else:
        gradient = (
            f"gradients=s={width}x{height}:c0=0x1e1b4b:c1=0xbe185d:"
            f"x0=0:y0=0:x1={width}:y1={height}:speed=0.02"
        )
        inputs = ["-f", "lavfi", "-i", gradient]
        vf = f"{dim},{subs},format=yuv420p"

    run([
        "ffmpeg", "-y", *inputs, "-i", str(audio),
        "-vf", vf, "-r", "30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-movflags", "+faststart", str(out_mp4),
    ])
    return out_mp4


def _stored_background(work: Path) -> Path | None:
    return next(iter(work.glob("background.*")), None)


def render_reel(
    job_id: str,
    instrumental: Path | None = None,
    image: str | Path | None = None,
    on_status: Callable[[str], None] | None = None,
) -> Path:
    """Render (or re-render) the job's reel mp4 from its stored instrumental, lyrics and background.

    Pass `instrumental` / `image` on the first render to store them in the job folder;
    later renders (after the user edits lyrics) reuse what is stored.
    """
    work = project_store.job_dir(job_id)
    if instrumental is not None:
        shutil.copyfile(instrumental, work / "instrumental.wav")
    if image is not None:
        for old in work.glob("background.*"):
            old.unlink()
        shutil.copyfile(image, work / f"background{Path(image).suffix.lower()}")

    audio = work / "instrumental.wav"
    lines = lyrics.load_lines(work)
    if not audio.exists() or lines is None:
        raise FileNotFoundError("Reel data not found for this job")

    if on_status:
        on_status("Rendering video...")
    return render_video(audio, lines, _stored_background(work), OUTPUT_DIR / f"{job_id}.mp4", work)
