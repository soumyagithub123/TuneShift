from pathlib import Path

from app.config import SOUNDFONT_DIR

# "program" is the General MIDI program number used when no dedicated <id>.sf2 exists.
INSTRUMENTS = [
    {"id": "sitar", "name": "Sitar", "program": 104},
    {"id": "guitar", "name": "Guitar", "program": 24},
    {"id": "flute", "name": "Flute", "program": 73},
    {"id": "piano", "name": "Piano", "program": 0},
    {"id": "violin", "name": "Violin", "program": 40},
    {"id": "santoor", "name": "Santoor", "program": 15},
]

_BY_ID = {i["id"]: i for i in INSTRUMENTS}


def is_valid(instrument_id: str) -> bool:
    return instrument_id in _BY_ID


def program_for(instrument_id: str) -> int:
    return _BY_ID[instrument_id]["program"]


def soundfont_for(instrument_id: str) -> Path:
    specific = SOUNDFONT_DIR / f"{instrument_id}.sf2"
    if specific.exists():
        return specific
    default = SOUNDFONT_DIR / "default.sf2"
    if default.exists():
        return default
    raise FileNotFoundError(
        f"No soundfont for '{instrument_id}'. Put {instrument_id}.sf2 (or default.sf2) in backend/soundfonts/"
    )
