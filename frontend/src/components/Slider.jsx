import { useState } from 'react';

export default function Slider({ label, value, min, max, step, format, disabled, onCommit }) {
  const [dragging, setDragging] = useState(null);
  const shown = dragging ?? value;

  const commit = () => {
    if (dragging !== null && dragging !== value) onCommit(dragging);
    setDragging(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">{label}</h4>
        <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-1 rounded">{format(shown)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(e) => setDragging(parseFloat(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 disabled:opacity-50"
      />
    </div>
  );
}
