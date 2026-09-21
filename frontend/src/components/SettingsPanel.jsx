import Section from './Section';
import Toggle from './Toggle';

export default function SettingsPanel({ settings, onChange }) {
  const set = (key, value) => onChange({ ...settings, [key]: value });

  return (
    <Section step={3} title="Customize (Optional)">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-5">
        <Toggle
          label="AI Compose"
          description="AI adds chords and bass under the melody"
          checked={settings.compose}
          onChange={(v) => set('compose', v)}
        />
        <Toggle
          label="Note Smoothing"
          description="Cleans up very short notes and glitches"
          checked={settings.note_smoothing}
          onChange={(v) => set('note_smoothing', v)}
        />
        <Toggle
          label="Pitch Bend"
          description="Allows sliding between notes"
          checked={settings.pitch_bend}
          onChange={(v) => set('pitch_bend', v)}
        />
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">Tempo</h3>
            <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-1 rounded">{settings.tempo}x</span>
          </div>
          <input
            type="range"
            min="0.5"
            max="2.0"
            step="0.1"
            value={settings.tempo}
            onChange={(e) => set('tempo', parseFloat(e.target.value))}
            className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
        </div>
      </div>
    </Section>
  );
}
