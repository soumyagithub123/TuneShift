import Section from './Section';

export default function InstrumentPicker({ instruments, value, onChange }) {
  return (
    <Section step={2} title="Choose Instrument">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {instruments.map((inst) => (
          <button
            key={inst.id}
            onClick={() => onChange(inst.id)}
            className={`p-4 rounded-xl border transition-all text-center font-medium ${
              value === inst.id
                ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600 text-zinc-300'
            }`}
          >
            {inst.name}
          </button>
        ))}
      </div>
    </Section>
  );
}
