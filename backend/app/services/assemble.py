import pretty_midi
from pydub import AudioSegment, effects

from app.config import OUTPUT_DIR
from app.schemas import Chord, Project
from app.services import instruments, project as project_store
from app.services.compose import QUALITIES, WINDOW
from app.services.render import render_midi

MIN_NOTE_SECONDS = 0.1
BASS_PROGRAM = 32
CHORD_PROGRAM = {"block": 48, "arpeggio": 46, "strum": 25}

# Reed/drone instruments sustain through short breaths in the sung melody instead of
# clicking off between notes, so we stretch each note to meet the next one when the
# gap is small. Longer gaps are real pauses and stay silent.
# 0.22s comes from a real harmonium reference clip: basic_pitch found gaps up to that
# length between consecutive notes, with none of them being an actual silent pause.
LEGATO_INSTRUMENTS = {"harmonium", "organ", "accordion"}
LEGATO_MAX_GAP = 0.22


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _apply_legato(notes: list[tuple[int, float, float, int]], max_gap: float):
    notes = sorted(notes, key=lambda n: n[1])
    out = []
    for i, (pitch, start, end, velocity) in enumerate(notes):
        if i + 1 < len(notes):
            gap = notes[i + 1][1] - end
            if 0 < gap <= max_gap:
                end = notes[i + 1][1]
        out.append((pitch, start, end, velocity))
    return out


def _chord_notes(chord: Chord, style: str, volume: float):
    tones = [48 + chord.root + i for i in QUALITIES[chord.quality]]
    velocity = _clamp(int(70 * volume), 1, 127)
    if style == "block":
        return [(p, chord.start, max(chord.start + 0.1, chord.end - 0.05), velocity) for p in tones]

    notes = []
    if style == "arpeggio":
        pattern = tones + tones[-2:0:-1]
        t, k = chord.start, 0
        while t < chord.end - 0.01:
            notes.append((pattern[k % len(pattern)], t, min(t + 0.75, chord.end), velocity))
            t, k = t + 0.5, k + 1
    else:
        t = chord.start
        while t < chord.end - 0.01:
            for j, p in enumerate(tones):
                notes.append((p, t + j * 0.03, min(t + 0.9, chord.end), velocity))
            t += 1.0
    return notes


def _bass_notes(chord: Chord, volume: float):
    velocity = _clamp(int(85 * volume), 1, 127)
    t = chord.start
    while t < chord.end - 0.01:
        yield 36 + chord.root, t, min(t + WINDOW, chord.end), velocity
        t += WINDOW


def build_midi(project: Project) -> pretty_midi.PrettyMIDI:
    source = pretty_midi.PrettyMIDI(str(project_store.melody_path(project.job_id)))
    out = pretty_midi.PrettyMIDI()

    def muted(t: float) -> bool:
        return any(a <= t < b for a, b in project.mute_ranges)

    def add(inst, pitch, start, end, velocity):
        if muted(start) or end <= start:
            return
        inst.notes.append(
            pretty_midi.Note(
                velocity=_clamp(velocity, 1, 127),
                pitch=_clamp(pitch + project.transpose, 0, 127),
                start=start,
                end=end,
            )
        )

    lead = pretty_midi.Instrument(program=instruments.program_for(project.instrument), name="lead")
    lead_notes = []
    for inst in source.instruments:
        for n in inst.notes:
            if project.note_smoothing and n.end - n.start < MIN_NOTE_SECONDS:
                continue
            lead_notes.append((n.pitch, n.start, n.end, int(n.velocity * project.melody_volume)))
        if project.pitch_bend:
            lead.pitch_bends.extend(b for b in inst.pitch_bends if not muted(b.time))
    if project.instrument in LEGATO_INSTRUMENTS:
        lead_notes = _apply_legato(lead_notes, LEGATO_MAX_GAP)
    for note in lead_notes:
        add(lead, *note)
    out.instruments.append(lead)

    if project.accompaniment and project.accompaniment_volume > 0 and project.chords:
        chords_inst = pretty_midi.Instrument(program=CHORD_PROGRAM[project.accompaniment_style], name="chords")
        bass_inst = pretty_midi.Instrument(program=BASS_PROGRAM, name="bass")
        for chord in project.chords:
            for note in _chord_notes(chord, project.accompaniment_style, project.accompaniment_volume):
                add(chords_inst, *note)
            for note in _bass_notes(chord, project.accompaniment_volume):
                add(bass_inst, *note)
        out.instruments += [chords_inst, bass_inst]

    for inst in out.instruments:
        for n in inst.notes:
            n.start /= project.tempo
            n.end /= project.tempo
        for b in inst.pitch_bends:
            b.time /= project.tempo
    return out


def render(project: Project):
    work = project_store.job_dir(project.job_id)
    midi_file, wav_file = work / "final.mid", work / "final.wav"
    build_midi(project).write(str(midi_file))
    render_midi(midi_file, instruments.soundfont_for(project.instrument), wav_file)

    target_ms = int(project.duration / project.tempo * 1000)
    audio = AudioSegment.from_file(str(wav_file))[:target_ms]
    if len(audio) < target_ms:
        audio += AudioSegment.silent(target_ms - len(audio), frame_rate=audio.frame_rate)
    out_mp3 = OUTPUT_DIR / f"{project.job_id}.mp3"
    effects.normalize(audio, headroom=1.0).export(str(out_mp3), format="mp3")
    return out_mp3
