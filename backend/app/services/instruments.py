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
    {"id": "electric_guitar", "name": "Electric guitar", "program": 27},
    {"id": "harmonium", "name": "Harmonium", "program": 20},
    {"id": "saxophone", "name": "Saxophone", "program": 65},
    {"id": "trumpet", "name": "Trumpet", "program": 56},
    {"id": "cello", "name": "Cello", "program": 42},
    {"id": "harp", "name": "Harp", "program": 46},
    {"id": "accordion", "name": "Accordion", "program": 21},
    {"id": "organ", "name": "Organ", "program": 19},
    {"id": "marimba", "name": "Marimba", "program": 12},
    {"id": "kalimba", "name": "Kalimba", "program": 108},
    {"id": "clarinet", "name": "Clarinet", "program": 71},
    {"id": "electric_piano", "name": "Electric piano", "program": 4},
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
