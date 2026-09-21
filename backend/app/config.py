import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

STORAGE_DIR = BASE_DIR / "storage"
UPLOAD_DIR = STORAGE_DIR / "uploads"
WORK_DIR = STORAGE_DIR / "work"
OUTPUT_DIR = STORAGE_DIR / "outputs"
SOUNDFONT_DIR = BASE_DIR / "soundfonts"

MAX_UPLOAD_BYTES = 15 * 1024 * 1024

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

for _dir in (UPLOAD_DIR, WORK_DIR, OUTPUT_DIR, SOUNDFONT_DIR):
    _dir.mkdir(parents=True, exist_ok=True)


def _add_to_path(directory: Path) -> None:
    os.environ["PATH"] = str(directory) + os.pathsep + os.environ["PATH"]


for _exe in (BASE_DIR / "bin").glob("**/fluidsynth.exe"):
    _add_to_path(_exe.parent)

# A terminal opened before ffmpeg was installed (e.g. VS Code) won't have it on PATH.
if not shutil.which("ffprobe"):
    _winget = Path(os.getenv("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    for _exe in _winget.glob("Gyan.FFmpeg*/**/bin/ffprobe.exe"):
        _add_to_path(_exe.parent)
        break
