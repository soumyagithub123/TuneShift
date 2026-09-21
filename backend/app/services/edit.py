import json

from pydantic import ValidationError

from app.schemas import EditOps, Project
from app.services import instruments, llm
from app.services.compose import STYLES

SYSTEM = (
    "You edit an AI-generated instrumental tune by changing its settings. You get the current settings "
    "and the user's request (any language, e.g. Hindi/Hinglish). Reply with JSON only, containing ONLY the "
    "fields that must change, plus a short friendly 'reply' saying what you changed. Fields: "
    "instrument (one of the given ids), transpose (absolute semitone offset from the original, -24..24; "
    "higher pitch = positive), tempo (absolute multiplier of original speed 0.5..2.0; 1.2 = faster), "
    "note_smoothing (bool), pitch_bend (bool), accompaniment (bool: chords+bass on/off), "
    "accompaniment_style (block|arpeggio|strum), accompaniment_volume (0..1), melody_volume (0..1), "
    "add_mute_ranges (list of [start_seconds, end_seconds] to silence), clear_mutes (bool). "
    "If the request cannot be done with these fields, change nothing and explain in 'reply'."
)


def ai_edit(project: Project, instruction: str) -> tuple[EditOps, str]:
    state = project.model_dump(exclude={"chords", "job_id", "version", "composed_by"})
    payload = {
        "current": state,
        "instrument_ids": [i["id"] for i in instruments.INSTRUMENTS],
        "styles": list(STYLES),
        "request": instruction,
    }
    data = llm.ask_json(SYSTEM, json.dumps(payload))
    reply = str(data.pop("reply", "Done."))
    try:
        ops = EditOps.model_validate({k: v for k, v in data.items() if v is not None})
    except ValidationError:
        return EditOps(), "I couldn't turn that into a valid change. Try rephrasing."
    return ops, reply
