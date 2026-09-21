import json
import unicodedata
from concurrent.futures import ThreadPoolExecutor
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


# Whisper skips stretches of sung audio (a 50 s clip lost 30 s of lyrics) and is not deterministic: the
# same window can come back empty once and full the next time. So the audio is transcribed in short
# overlapping windows, stitched back together, and a window that comes back empty is retried.
WINDOW_SEC = 8.0
WINDOW_OVERLAP = 2.0
SILENT_RMS = 0.003  # windows quieter than this are skipped so Whisper doesn't invent text for silence
MAX_PARALLEL = 8
EMPTY_RETRIES = 2


def _windows(total: float) -> list[tuple[float, float]]:
    out, start = [], 0.0
    while True:
        end = min(start + WINDOW_SEC, total)
        out.append((start, end))
        if end >= total:
            return out
        start += WINDOW_SEC - WINDOW_OVERLAP


def transcribe_words(source_wav: Path, language: str | None = None) -> tuple[list[Word], str | None]:
    """Word timestamps for the sung audio (empty if nothing is recognised) and the language used.

    Uses the OpenAI Whisper API when a key is configured (much faster than CPU Whisper),
    otherwise a local faster-whisper model. With `language=None` the language is auto-detected
    for the whole song: English stays English; anything else is transcribed as Hindi, because
    Whisper labels Indian songs unreliably (Urdu, Punjabi, ...).
    """
    import soundfile as sf

    audio, sr = sf.read(str(source_wav), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    windows = _windows(len(mono) / sr)

    jobs: list[tuple[int, float, float, Path]] = []
    for k, (start, end) in enumerate(windows):
        chunk = mono[int(start * sr) : int(end * sr)]
        if len(chunk) == 0 or float((chunk**2).mean() ** 0.5) < SILENT_RMS:
            continue
        path = source_wav.with_name(f"{source_wav.stem}.w{k}.wav")
        sf.write(str(path), chunk, sr)
        jobs.append((k, start, end, path))

    def run_once(path: Path, lang: str | None) -> tuple[list[Word], str]:
        for _attempt in range(1 + EMPTY_RETRIES):
            if OPENAI_API_KEY:
                try:
                    res = _transcribe_openai(path, lang)
                except Exception as e:
                    print(f"OpenAI transcription failed, falling back to local model: {e}")
                    res = _transcribe_local(path, lang)
            else:
                res = _transcribe_local(path, lang)
            if res[0]:
                break
        return res

    workers = MAX_PARALLEL if OPENAI_API_KEY else 1
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda j: run_once(j[3], language), jobs))

        final = language
        if language is None and results:
            english = sum(len(w) for w, d in results if d in ("english", "en"))
            other = sum(len(w) for w, d in results if d not in ("english", "en"))
            final = "en" if english > other else "hi"
            ok = ("english", "en") if final == "en" else ("hindi", "hi")
            redo = [i for i, (_w, d) in enumerate(results) if d not in ok]
            for i, res in zip(redo, pool.map(lambda i: run_once(jobs[i][3], final), redo)):
                results[i] = res

    words: list[Word] = []
    last = len(windows) - 1
    for (k, start, _end, path), (chunk_words, _d) in zip(jobs, results):
        # In the overlap keep each word from the window where it sits nearest the middle.
        lo = start + WINDOW_OVERLAP / 2 if k > 0 else 0.0
        hi = windows[k][1] - WINDOW_OVERLAP / 2 if k < last else float("inf")
        for w in chunk_words:
            if lo <= start + w.start < hi:
                words.append(Word(start + w.start, start + w.end, w.text))
        for f in (path, path.with_name(f"{path.stem}.upload.mp3")):
            f.unlink(missing_ok=True)
    return words, final


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
    "unclear, romanize it as heard. Use ONLY plain ASCII letters a-z: no Devanagari, Arabic or other "
    "scripts, and no accents or diacritics (write 'a' not 'ā', 'r' not 'ṛ', 'n' not 'ñ'). Reply with JSON only: {\"lines\": [<string>, ...]} with exactly as many strings as the input."
)
ROMANIZE_CHUNK = 40


def _has_non_latin(text: str) -> bool:
    return any(c.isalpha() and not c.isascii() for c in text)


def _ascii(text: str) -> str:
    """Strip accents (ā -> a, ṛ -> r) so the model's Roman spelling is plain English letters."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def _romanize_texts(texts: list[str], attempts: int) -> list[str] | None:
    from app.services import llm

    for _attempt in range(attempts):
        try:
            data = llm.ask_json(ROMANIZE_SYSTEM, json.dumps({"lines": texts}, ensure_ascii=False))
        except Exception as e:
            print(f"Romanizing failed: {e}")
            continue
        out = data.get("lines")
        if not (isinstance(out, list) and len(out) == len(texts) and all(isinstance(t, str) for t in out)):
            continue
        out = [_ascii(t).strip() for t in out]
        if not any(_has_non_latin(t) for t in out):
            return out
    return None


def _force_latin(text: str) -> str:
    """Last resort: mechanical transliteration, so no Hindi/Urdu script is ever shown."""
    from unidecode import unidecode

    return " ".join(unidecode(text).split())


def to_hinglish(lines: list[LyricLine]) -> list[LyricLine]:
    """Write lines that came out in Devanagari/Urdu script with English letters, keeping timings.

    Lines already in Latin letters (e.g. an English song) are left exactly as heard so they can never
    be translated. Lines in another script are romanized by the model (whole batch, then line by line)
    and, if that still fails, by a mechanical transliteration, so the result is always Latin letters.
    """
    todo = [i for i, l in enumerate(lines) if _has_non_latin(l.text)]
    out = list(lines)
    for c in range(0, len(todo), ROMANIZE_CHUNK):
        idx = todo[c : c + ROMANIZE_CHUNK]
        texts = _romanize_texts([lines[i].text for i in idx], attempts=3) if OPENAI_API_KEY else None
        if texts is None and OPENAI_API_KEY:
            texts = []
            for i in idx:
                one = _romanize_texts([lines[i].text], attempts=2)
                texts.append(one[0] if one else _force_latin(lines[i].text))
        if texts is None:
            texts = [_force_latin(lines[i].text) for i in idx]
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
