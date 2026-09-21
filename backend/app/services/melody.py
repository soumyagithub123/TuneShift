from pathlib import Path

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import predict_and_save


def extract_midi(vocals_wav: Path, out_dir: Path) -> Path:
    predict_and_save([str(vocals_wav)], str(out_dir), True, False, False, False, ICASSP_2022_MODEL_PATH)
    target = out_dir / "melody.mid"
    (out_dir / f"{vocals_wav.stem}_basic_pitch.mid").replace(target)
    return target
