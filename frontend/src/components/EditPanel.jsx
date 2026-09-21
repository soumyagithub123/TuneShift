import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { STYLES } from '../constants/instruments';
import Slider from './Slider';
import Toggle from './Toggle';

const chip = (active) =>
  `px-3 py-2 rounded-lg border text-sm font-medium transition-all disabled:opacity-50 ${
    active
      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
      : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600 text-zinc-300'
  }`;

export default function EditPanel({ project, instruments, busy, aiReply, onEdit, onAiEdit }) {
  const [prompt, setPrompt] = useState('');

  const submitPrompt = (e) => {
    e.preventDefault();
    if (!prompt.trim() || busy) return;
    onAiEdit(prompt.trim());
    setPrompt('');
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Edit your tune</h3>
        {busy && (
          <span className="text-xs text-indigo-300 flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" /> Updating...
          </span>
        )}
      </div>

      <form onSubmit={submitPrompt} className="space-y-2">
        <div className="flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
            maxLength={500}
            placeholder='Ask AI: "make it violin and a bit slower"'
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={busy || !prompt.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 px-4 rounded-lg text-sm font-medium flex items-center gap-1"
          >
            <Sparkles className="w-4 h-4" /> Apply
          </button>
        </div>
        {aiReply && <p className="text-xs text-indigo-300">{aiReply}</p>}
      </form>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Instrument</h4>
        <div className="flex flex-wrap gap-2">
          {instruments.map((inst) => (
            <button
              key={inst.id}
              disabled={busy}
              onClick={() => inst.id !== project.instrument && onEdit({ instrument: inst.id })}
              className={chip(project.instrument === inst.id)}
            >
              {inst.name}
            </button>
          ))}
        </div>
      </div>

      <Slider
        label="Pitch"
        value={project.transpose}
        min={-12}
        max={12}
        step={1}
        disabled={busy}
        format={(v) => (v > 0 ? `+${v}` : `${v}`) + ' semitones'}
        onCommit={(v) => onEdit({ transpose: v })}
      />
      <Slider
        label="Tempo"
        value={project.tempo}
        min={0.5}
        max={2}
        step={0.1}
        disabled={busy}
        format={(v) => `${v.toFixed(1)}x`}
        onCommit={(v) => onEdit({ tempo: v })}
      />
      <Slider
        label="Melody volume"
        value={project.melody_volume}
        min={0}
        max={1}
        step={0.05}
        disabled={busy}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={(v) => onEdit({ melody_volume: v })}
      />

      {project.chords.length > 0 && (
        <div className="space-y-4 pt-4 border-t border-zinc-800">
          <Toggle
            label="Chords & bass"
            description={project.composed_by === 'ai' ? 'Composed by AI' : 'Composed locally (AI unavailable)'}
            checked={project.accompaniment}
            onChange={(v) => onEdit({ accompaniment: v })}
          />
          {project.accompaniment && (
            <>
              <div className="flex flex-wrap gap-2">
                {STYLES.map((s) => (
                  <button
                    key={s.id}
                    disabled={busy}
                    onClick={() => onEdit({ accompaniment_style: s.id })}
                    className={chip(project.accompaniment_style === s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <Slider
                label="Chords volume"
                value={project.accompaniment_volume}
                min={0}
                max={1}
                step={0.05}
                disabled={busy}
                format={(v) => `${Math.round(v * 100)}%`}
                onCommit={(v) => onEdit({ accompaniment_volume: v })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
