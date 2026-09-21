"""Find the "hook" of a song: the chorus, and every place it comes back.

The song is compared with itself. A stretch that sounds like several other stretches is a chorus;
each of its repeats is reported, moved to the moment the chorus actually kicks in.
"""
from pathlib import Path

import librosa
import numpy as np

from app.schemas import HookCandidate

SR = 11025
HOP = SR // 2  # two feature frames per second
N_FFT = 4096
FPS = SR / HOP

HOOK_SEC = 30.0  # length of the part that is suggested from each hook
CHORUS_SEC = 12.0  # length of the stretches that are compared with each other
MAX_HOOKS = 4
REPEAT_PERCENTILE = 95  # two stretches count as "the same" when they are among the most alike pairs
LOUD_WEIGHT = 0.25  # a chorus is usually louder, but repetition matters more
ENTRY_SEARCH = int(3 * FPS)  # look +-3 s around a repeat for the moment the chorus starts
ENTRY_SPAN = int(4 * FPS)  # compare the 4 s before and after a possible start
BEAT_SNAP_SEC = 1.0


def _features(y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame unit vectors (harmony + timbre) for cosine similarity, and per-frame loudness."""
    chroma = librosa.feature.chroma_stft(y=y, sr=SR, n_fft=N_FFT, hop_length=HOP)
    mfcc = librosa.feature.mfcc(y=y, sr=SR, n_mfcc=13, n_fft=N_FFT, hop_length=HOP)[1:]
    rms = librosa.feature.rms(y=y, frame_length=N_FFT, hop_length=HOP)[0]
    n = min(chroma.shape[1], mfcc.shape[1], len(rms))
    chroma = chroma[:, :n] / (np.linalg.norm(chroma[:, :n], axis=0, keepdims=True) + 1e-9)
    mfcc = mfcc[:, :n]
    mfcc = 0.5 * (mfcc - mfcc.mean(axis=1, keepdims=True)) / (mfcc.std(axis=1, keepdims=True) + 1e-9)
    feat = np.vstack([chroma, mfcc])
    feat /= np.linalg.norm(feat, axis=0, keepdims=True) + 1e-9
    return feat, rms[:n]


def _window_similarity(S: np.ndarray, L: int) -> np.ndarray:
    """W[i, j] = how alike the L-frame stretches starting at i and j are (-1 where not comparable).

    Only non-overlapping pairs are compared, so a stretch is never "repeated" by its own neighbour.
    """
    F = S.shape[0]
    W = np.full((F, F), -1.0)
    for d in range(L, F - L + 1):
        diag = np.diagonal(S, offset=d)
        cs = np.concatenate([[0.0], np.cumsum(diag)])
        win = (cs[L:] - cs[:-L]) / L
        idx = np.arange(len(win))
        W[idx, idx + d] = win
        W[idx + d, idx] = win
    return W


def _repeats_of(row: np.ndarray, L: int, tau: float, limit: int) -> list[int]:
    """Distinct places (at least L frames apart) where a stretch comes back with similarity >= tau."""
    row = row.copy()
    found: list[int] = []
    for _ in range(limit):
        j = int(np.argmax(row))
        if row[j] < tau:
            break
        found.append(j)
        row[max(0, j - L) : j + L] = -1
    return found


def _minmax(x: np.ndarray) -> np.ndarray:
    span = x.max() - x.min()
    return (x - x.min()) / span if span > 1e-9 else np.zeros_like(x)


def _chorus_entry(rms: np.ndarray, p: int) -> int:
    """Frame near p where the music gets the biggest lift, i.e. where the chorus kicks in."""
    lo = max(ENTRY_SPAN, p - ENTRY_SEARCH)
    hi = min(len(rms) - ENTRY_SPAN, p + ENTRY_SEARCH)
    if hi <= lo:
        return p
    lifts = [rms[q : q + ENTRY_SPAN].mean() - rms[q - ENTRY_SPAN : q].mean() for q in range(lo, hi + 1)]
    return lo + int(np.argmax(lifts))


def _snap_to_beat(t: float, beats: np.ndarray) -> float:
    if len(beats) == 0:
        return t
    nearest = beats[int(np.argmin(np.abs(beats - t)))]
    return float(nearest) if abs(nearest - t) <= BEAT_SNAP_SEC else t


def find_hooks(wav_path: Path) -> dict[str, list[HookCandidate]]:
    """The best hook first, then its other repeats, keyed by the length of the suggested part."""
    key = str(int(HOOK_SEC))
    y, _ = librosa.load(str(wav_path), sr=SR, mono=True)
    duration = len(y) / SR
    if duration <= HOOK_SEC:
        return {key: [HookCandidate(start=0.0, end=round(duration, 2), score=1.0)]}

    feat, rms = _features(y)
    F = feat.shape[1]
    S = feat.T @ feat
    L = int(CHORUS_SEC * FPS)
    starts = max(F - L + 1, 1)
    W = _window_similarity(S, L)

    valid = W[W >= 0]
    tau = float(np.percentile(valid, REPEAT_PERCENTILE)) if valid.size else 2.0

    repeats = np.zeros(starts)
    best = np.zeros(starts)
    for i in range(starts):
        repeats[i] = len(_repeats_of(W[i], L, tau, MAX_HOOKS + 2))
        best[i] = max(float(W[i].max()), 0.0)
    loud = np.convolve(rms, np.ones(L) / L, mode="valid")[:starts]
    score = (1 - LOUD_WEIGHT) * _minmax(repeats + best) + LOUD_WEIGHT * _minmax(loud)

    anchor = int(np.argmax(score))
    places = [anchor] + _repeats_of(W[anchor], L, tau, MAX_HOOKS - 1)
    if len(places) == 1:
        # Nothing clearly repeats (rap, ghazal, ...): fall back to the strongest separate stretches.
        for i in np.argsort(-score):
            if all(abs(int(i) - p) >= L for p in places):
                places.append(int(i))
            if len(places) == 3:
                break

    try:
        beats = librosa.frames_to_time(librosa.beat.beat_track(y=y, sr=SR)[1], sr=SR)
    except Exception:
        beats = np.array([])

    hooks: list[HookCandidate] = []
    for p in places:
        start = _snap_to_beat(_chorus_entry(rms, p) / FPS, beats)
        start = max(0.0, min(start, duration - HOOK_SEC))
        hooks.append(HookCandidate(start=round(start, 2), end=round(start + HOOK_SEC, 2), score=round(float(score[min(p, starts - 1)]), 3)))
    return {key: hooks}
