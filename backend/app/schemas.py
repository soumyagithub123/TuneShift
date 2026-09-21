from typing import Literal

from pydantic import BaseModel, Field


class JobStatus(BaseModel):
    job_id: str
    status: str
    message: str


class TuneSettings(BaseModel):
    note_smoothing: bool = False
    pitch_bend: bool = False
    tempo: float = Field(1.0, ge=0.5, le=2.0)
    mode: Literal["remove_voice", "compose", "reel", "lyrics"] = "compose"
    isolate_vocals: bool = False  # lyrics mode: run vocal separation first (slower, better on loud mixes)


class LyricLine(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str = Field(max_length=200)


class ImagePromptRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=500)
    aspect: str = "9:16"


class HookCandidate(BaseModel):
    start: float
    end: float
    score: float


class RenderReelRequest(BaseModel):
    lines: list[LyricLine] = Field(max_length=200)


class Instrument(BaseModel):
    id: str
    name: str
    program: int


Style = Literal["block", "arpeggio", "strum"]


class Chord(BaseModel):
    start: float
    end: float
    root: int = Field(ge=0, le=11)
    quality: Literal["maj", "min", "dom7", "min7"]


class Project(BaseModel):
    job_id: str
    duration: float
    instrument: str
    tempo: float = 1.0
    transpose: int = 0
    note_smoothing: bool = False
    pitch_bend: bool = False
    accompaniment: bool = True
    accompaniment_style: Style = "arpeggio"
    accompaniment_volume: float = 0.6
    melody_volume: float = 1.0
    mute_ranges: list[tuple[float, float]] = []
    chords: list[Chord] = []
    composed_by: str = "none"
    version: int = 0


class EditOps(BaseModel):
    instrument: str | None = None
    transpose: int | None = Field(None, ge=-24, le=24)
    tempo: float | None = Field(None, ge=0.5, le=2.0)
    note_smoothing: bool | None = None
    pitch_bend: bool | None = None
    accompaniment: bool | None = None
    accompaniment_style: Style | None = None
    accompaniment_volume: float | None = Field(None, ge=0, le=1)
    melody_volume: float | None = Field(None, ge=0, le=1)
    add_mute_ranges: list[tuple[float, float]] = []
    clear_mutes: bool = False


class AiEditRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=500)


class AiEditResponse(BaseModel):
    project: Project
    reply: str
