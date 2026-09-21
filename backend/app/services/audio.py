from pathlib import Path

from pydub import AudioSegment


def trim_to_wav(input_file: str, start_sec: float, length_sec: float, out_wav: Path) -> float:
    audio = AudioSegment.from_file(input_file)
    if length_sec > 0:
        start_ms = int(start_sec * 1000)
        audio = audio[start_ms : start_ms + int(length_sec * 1000)]
    audio.export(str(out_wav), format="wav")
    return len(audio) / 1000
