import json
from dataclasses import dataclass
from pathlib import Path

from app.config import OPENAI_API_KEY
from app.schemas import LyricLine
from app.services.shell import run

MAX_WORDS_PER_LINE = 5
MAX_LINE_GAP = 1.2  # seconds of silence that forces a new line

_local_model = None


@dataclass
class Word:
    start: float
    end: float
    text: str


def _transcribe_openai(vocals_wav: Path, language: str | None) -> tuple[list[Word], str]:
    from openai import OpenAI

    # The API rejects files over 25MB; a mono 16 kHz mp3 is plenty for speech recognition and small.
    small = vocals_wav.with_name(f"{vocals_wav.stem}.upload.mp3")
    run(["ffmpeg", "-y", "-i", str(vocals_wav), "-ac", "1", "-ar", "16000", "-b:a", "48k", str(small)])

    client = OpenAI(api_key=OPENAI_API_KEY, timeout=120)
    kwargs = {"language": language} if language else {}
    with open(small, "rb") as f:
        result = client.audio.transcriptions.create(
            model="whisper-1",
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["word"],
            **kwargs,
        )
    words = [Word(w.start, w.end, w.word.strip()) for w in (result.words or []) if w.word.strip()]
    return words, (getattr(result, "language", None) or "").lower()


def _transcribe_local(vocals_wav: Path, language: str | None) -> tuple[list[Word], str]:
    global _local_model
    if _local_model is None:
        from faster_whisper import WhisperModel

        _local_model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, info = _local_model.transcribe(
        str(vocals_wav),
        language=language,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    words = [
        Word(w.start, w.end, w.word.strip())
        for seg in segments
        for w in (seg.words or [])
        if w.word.strip()
    ]
    return words, (info.language or "").lower()


def transcribe_words(vocals_wav: Path, language: str | None = None) -> list[Word]:
    """Word timestamps for the sung vocals; empty if nothing is recognised.

    Uses the OpenAI Whisper API when a key is configured (much faster than CPU Whisper),
    otherwise a local faster-whisper model. With `language=None` the language is auto-detected,
    but Whisper labels Indian songs unreliably (Urdu, Punjabi, ...), so anything not detected as
    English is re-run as Hindi.
    """
    def run_once(lang: str | None) -> tuple[list[Word], str]:
        if OPENAI_API_KEY:
            try:
                return _transcribe_openai(vocals_wav, lang)
            except Exception as e:
                print(f"OpenAI transcription failed, falling back to local model: {e}")
        return _transcribe_local(vocals_wav, lang)

    words, detected = run_once(language)
    if language is None and detected not in ("english", "en"):
        words, _ = run_once("hi")
    return words


def group_lines(
    words: list[Word], max_words: int = MAX_WORDS_PER_LINE, max_gap: float = MAX_LINE_GAP
) -> list[LyricLine]:
    groups: list[list[Word]] = []
    for w in words:
        if (
            not groups
            or len(groups[-1]) >= max_words
            or w.start - groups[-1][-1].end > max_gap
        ):
            groups.append([])
        groups[-1].append(w)
    return [
        LyricLine(start=g[0].start, end=g[-1].end, text=" ".join(w.text for w in g))
        for g in groups
    ]


ROMANIZE_SYSTEM = (
    "You romanize song lyric lines produced by speech recognition, so they can be typed on an English "
    "keyboard exactly as they sound when sung (like the Roman-script lyrics in music apps). Hindi, Urdu and "
    "Punjabi words become their common Roman spelling ('ishq', 'mere', 'hai'). English words, even when "
    "written in Devanagari or Arabic script (for example a Devanagari 'baby'), become normal English spelling "
    "('baby'). This is transliteration, NOT translation: never translate any word into another language, "
    "never change the meaning, and never add, drop, merge, split or reorder words or lines. If a word is "
    "unclear, romanize it as heard. The output must contain only Latin letters, no Devanagari, Arabic or "
    "other scripts. Reply with JSON only: {\"lines\": [<string>, ...]} with exactly as many strings as the input."
)
ROMANIZE_CHUNK = 40


def _has_non_latin(text: str) -> bool:
    return any(c.isalpha() and not c.isascii() for c in text)


def _romanize_chunk(texts: list[str]) -> list[str] | None:
    from app.services import llm

    for _attempt in range(2):
        try:
            data = llm.ask_json(ROMANIZE_SYSTEM, json.dumps({"lines": texts}, ensure_ascii=False))
        except Exception as e:
            print(f"Romanizing failed: {e}")
            continue
        out = data.get("lines")
        if (
            isinstance(out, list)
            and len(out) == len(texts)
            and all(isinstance(t, str) for t in out)
            and not any(_has_non_latin(t) for t in out)
        ):
            return [t.strip() for t in out]
    return None


def to_hinglish(lines: list[LyricLine]) -> list[LyricLine]:
    """Write lines that came out in Devanagari/Urdu script with English letters, keeping timings.

    Lines that are already in Latin letters (e.g. an English song) are left exactly as heard so they
    can never be translated. Without an OpenAI key, or if the model's reply does not line up with the
    input, the original text is kept.
    """
    if not OPENAI_API_KEY:
        return lines
    todo = [i for i, l in enumerate(lines) if _has_non_latin(l.text)]
    out = list(lines)
    for c in range(0, len(todo), ROMANIZE_CHUNK):
        idx = todo[c : c + ROMANIZE_CHUNK]
        texts = _romanize_chunk([lines[i].text for i in idx])
        if texts is None:
            continue
        for i, t in zip(idx, texts):
            out[i] = LyricLine(start=lines[i].start, end=lines[i].end, text=t)
    return out


def lyrics_path(work: Path) -> Path:
    return work / "lyrics.json"


def save_lines(work: Path, lines: list[LyricLine]) -> None:
    data = [line.model_dump() for line in lines]
    lyrics_path(work).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_lines(work: Path) -> list[LyricLine] | None:
    path = lyrics_path(work)
    if not path.exists():
        return None
    return [LyricLine(**d) for d in json.loads(path.read_text(encoding="utf-8"))]
