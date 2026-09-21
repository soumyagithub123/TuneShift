import argparse
import os
import subprocess
from pathlib import Path
from pydub import AudioSegment
import librosa
import soundfile as sf
import numpy as np
from basic_pitch.inference import predict_and_save

def trim_audio(input_file: str, start_sec: float, length_sec: float, out_file: str):
    print(f"Trimming audio from {start_sec}s for {length_sec}s...")
    audio = AudioSegment.from_file(input_file)
    start_ms = int(start_sec * 1000)
    end_ms = start_ms + int(length_sec * 1000)
    trimmed = audio[start_ms:end_ms]
    trimmed.export(out_file, format="wav")
    print(f"Trimmed audio saved to {out_file}")

def separate_vocals(input_file: str, out_dir: str) -> str:
    print("Separating vocals using Demucs...")
    # Using htdemucs model and extracting only vocals to save time
    cmd = [
        "demucs", "-n", "htdemucs",
        "--two-stems=vocals",
        input_file,
        "-o", out_dir
    ]
    subprocess.run(cmd, check=True)
    
    # Demucs outputs to: {out_dir}/htdemucs/{filename}/vocals.wav
    filename = Path(input_file).stem
    vocals_path = Path(out_dir) / "htdemucs" / filename / "vocals.wav"
    return str(vocals_path)

def extract_melody(vocals_file: str, out_dir: str) -> str:
    print("Extracting melody to MIDI using Basic Pitch...")
    # predict_and_save args: audio_path_list, output_directory, save_midi, sonify_midi, save_model_outputs, save_notes
    predict_and_save(
        [vocals_file],
        out_dir,
        True,  # save_midi
        False, # sonify_midi
        False, # save_model_outputs
        False  # save_notes
    )
    filename = Path(vocals_file).stem
    midi_path = Path(out_dir) / f"{filename}_basic_pitch.mid"
    return str(midi_path)

def render_midi(midi_file: str, soundfont_path: str, out_wav: str):
    print(f"Rendering MIDI to audio using FluidSynth with {soundfont_path}...")
    cmd = [
        "fluidsynth", "-ni",
        soundfont_path,
        midi_file,
        "-F", out_wav,
        "-r", "44100"
    ]
    subprocess.run(cmd, check=True)
    print(f"Rendered audio saved to {out_wav}")

def process_tabla(vocals_file: str, tabla_loop_file: str, out_tabla: str):
    print("Detecting tempo and adjusting tabla loop...")
    # Detect tempo of the vocals
    y_voc, sr_voc = librosa.load(vocals_file)
    tempo, _ = librosa.beat.beat_track(y=y_voc, sr=sr_voc)
    if isinstance(tempo, (list, tuple, np.ndarray)):
        tempo = tempo[0]
    print(f"Detected tempo: {tempo:.2f} BPM")
    
    # Load tabla
    y_tab, sr_tab = librosa.load(tabla_loop_file)
    tempo_tab, _ = librosa.beat.beat_track(y=y_tab, sr=sr_tab)
    if isinstance(tempo_tab, (list, tuple, np.ndarray)):
        tempo_tab = tempo_tab[0]
    print(f"Tabla original tempo: {tempo_tab:.2f} BPM")
    
    # Time stretch tabla to match vocals
    rate = tempo / tempo_tab if tempo_tab > 0 else 1.0
    y_tab_stretched = librosa.effects.time_stretch(y_tab, rate=rate)
    
    # Save stretched tabla
    sf.write(out_tabla, y_tab_stretched, sr_tab)
    print(f"Stretched tabla saved to {out_tabla}")

def mix_audio(instrument_wav: str, tabla_wav: str, out_mp3: str):
    print("Mixing instrument and tabla...")
    inst = AudioSegment.from_file(instrument_wav)
    tab = AudioSegment.from_file(tabla_wav)
    
    # Loop tabla to match instrument duration if needed
    if len(tab) < len(inst):
        times_to_loop = (len(inst) // len(tab)) + 1
        tab = tab * times_to_loop
    
    # Trim to exact length
    tab = tab[:len(inst)]
    
    # Mix
    mixed = inst.overlay(tab)
    mixed.export(out_mp3, format="mp3")
    print(f"Final mix saved to {out_mp3}")

def main():
    parser = argparse.ArgumentParser(description="TuneShift CLI Pipeline")
    parser.add_argument("input_file", help="Input audio file")
    parser.add_argument("--start", type=float, required=True, help="Start time in seconds")
    parser.add_argument("--length", type=float, required=True, help="Length in seconds")
    parser.add_argument("--instrument", required=True, help="Instrument name (corresponds to .sf2 file)")
    parser.add_argument("--tabla", action="store_true", help="Add tabla beat")
    
    args = parser.parse_args()
    
    # Setup paths
    base_dir = Path(__file__).parent.parent
    work_dir = base_dir / "samples" / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    
    soundfont = base_dir / "soundfonts" / f"{args.instrument}.sf2"
    if not soundfont.exists():
        print(f"Error: Soundfont not found at {soundfont}")
        print("Please download a .sf2 file for this instrument and place it in the soundfonts folder.")
        return
        
    tabla_loop = base_dir / "soundfonts" / "tabla_loop.wav"
    if args.tabla and not tabla_loop.exists():
        print(f"Error: Tabla loop not found at {tabla_loop}")
        return

    # 1. Trim
    trimmed_wav = str(work_dir / "trimmed.wav")
    trim_audio(args.input_file, args.start, args.length, trimmed_wav)
    
    # 2. Separate Vocals
    demucs_out = str(work_dir / "demucs")
    vocals_wav = separate_vocals(trimmed_wav, demucs_out)
    
    # 3. Extract Melody
    midi_file = extract_melody(vocals_wav, str(work_dir))
    
    # 4. Render MIDI
    rendered_wav = str(work_dir / "rendered.wav")
    render_midi(midi_file, str(soundfont), rendered_wav)
    
    # 5. Tabla & Mix
    final_out = str(base_dir / "samples" / "final_output.mp3")
    if args.tabla:
        stretched_tabla = str(work_dir / "tabla_stretched.wav")
        process_tabla(vocals_wav, str(tabla_loop), stretched_tabla)
        mix_audio(rendered_wav, stretched_tabla, final_out)
    else:
        # Just convert to mp3
        inst = AudioSegment.from_file(rendered_wav)
        inst.export(final_out, format="mp3")
        print(f"Final output saved to {final_out}")

if __name__ == "__main__":
    main()
