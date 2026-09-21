import json
import math
from pathlib import Path

import pretty_midi

from app.schemas import Chord
from app.services import llm

WINDOW = 2.0
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_ROOTS = {**{n: i for i, n in enumerate(NOTE_NAMES)}, "Db": 1, "Eb": 3, "Gb": 6, "Ab": 8, "Bb": 10}
QUALITIES = {"maj": (0, 4, 7), "min": (0, 3, 7), "dom7": (0, 4, 7, 10), "min7": (0, 3, 7, 10)}
STYLES = ("block", "arpeggio", "strum")

SYSTEM = (
    "You are a music arranger. You receive a melody summarised per time window (the pitch classes "
    "that sound most in each window). Choose a musically sensible chord for EVERY window so the chords "
    "support the melody, with a coherent key and a natural progression (avoid changing chord every "
    "window without reason). Also choose an accompaniment style. Reply with JSON only: "
    '{"key": "C major", "style": "block|arpeggio|strum", '
    '"chords": [{"i": 0, "root": "C", "quality": "maj|min|dom7|min7"}, ...]} '
    "with exactly one entry per window index."
)


def _window_weights(midi_path: Path, duration: float) -> list[list[float]]:
    count = max(1, math.ceil(duration / WINDOW))
    weights = [[0.0] * 12 for _ in range(count)]
    for inst in pretty_midi.PrettyMIDI(str(midi_path)).instruments:
        for note in inst.notes:
            w = min(int(note.start // WINDOW), count - 1)
            weights[w][note.pitch % 12] += note.end - note.start
    return weights


def _local_chords(weights: list[list[float]]) -> list[tuple[int, str]]:
    result: list[tuple[int, str]] = []
    previous = (0, "maj")
    for w in weights:
        if sum(w) == 0:
            result.append(previous)
            continue
        best, best_score = previous, -1.0
        for root in range(12):
            for quality in ("maj", "min"):
                tones = {(root + i) % 12 for i in QUALITIES[quality]}
                score = sum(w[pc] for pc in tones) + 0.2 * w[root]
                if score > best_score:
                    best, best_score = (root, quality), score
        result.append(best)
        previous = best
    return result


def _ai_chords(weights: list[list[float]], duration: float) -> tuple[list[tuple[int, str]], str]:
    windows = []
    for i, w in enumerate(weights):
        top = sorted(range(12), key=lambda pc: -w[pc])[:4]
        windows.append({"i": i, "pitch_classes": [NOTE_NAMES[pc] for pc in top if w[pc] > 0]})
    data = llm.ask_json(SYSTEM, json.dumps({"duration_seconds": round(duration, 1), "window_seconds": WINDOW, "windows": windows}))

    by_index: dict[int, tuple[int, str]] = {}
    for item in data["chords"]:
        root, quality = _ROOTS[item["root"]], item["quality"]
        if quality in QUALITIES:
            by_index[int(item["i"])] = (root, quality)
    if not by_index:
        raise ValueError("AI returned no usable chords")

    chords, previous = [], next(iter(by_index.values()))
    for i in range(len(weights)):
        previous = by_index.get(i, previous)
        chords.append(previous)
    style = data.get("style") if data.get("style") in STYLES else "arpeggio"
    return chords, style


def compose(midi_path: Path, duration: float) -> tuple[list[Chord], str, str]:
    weights = _window_weights(midi_path, duration)
    style, source = "arpeggio", "ai"
    try:
        if not llm.available():
            raise RuntimeError("no OPENAI_API_KEY")
        picks, style = _ai_chords(weights, duration)
    except Exception as e:
        print(f"AI compose unavailable, using local harmony: {e}")
        picks, source = _local_chords(weights), "local"

    chords: list[Chord] = []
    for i, (root, quality) in enumerate(picks):
        start, end = i * WINDOW, min((i + 1) * WINDOW, duration)
        if chords and chords[-1].root == root and chords[-1].quality == quality:
            chords[-1].end = end
        else:
            chords.append(Chord(start=start, end=end, root=root, quality=quality))
    return chords, style, source
