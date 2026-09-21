from pathlib import Path

from app.services.shell import run


def render_midi(midi_file: Path, soundfont: Path, out_wav: Path) -> None:
    run(["fluidsynth", "-ni", "-F", str(out_wav), "-r", "44100", str(soundfont), str(midi_file)])
