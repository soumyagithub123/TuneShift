import { useState, useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { ArrowLeft, Upload, Play, Pause, Loader2, Download, Check, Music, Headphones, Wand2 } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const POLL_MS = 2000;

const INSTRUMENTS = [
  { id: 'sitar', name: 'Sitar' },
  { id: 'guitar', name: 'Guitar' },
  { id: 'flute', name: 'Flute' },
  { id: 'piano', name: 'Piano' },
  { id: 'violin', name: 'Violin' },
  { id: 'santoor', name: 'Santoor' },
  { id: 'electric_guitar', name: 'Electric guitar' },
  { id: 'harmonium', name: 'Harmonium' },
  { id: 'saxophone', name: 'Saxophone' },
  { id: 'trumpet', name: 'Trumpet' },
  { id: 'cello', name: 'Cello' },
  { id: 'harp', name: 'Harp' },
  { id: 'accordion', name: 'Accordion' },
  { id: 'organ', name: 'Organ' },
  { id: 'marimba', name: 'Marimba' },
  { id: 'kalimba', name: 'Kalimba' },
  { id: 'clarinet', name: 'Clarinet' },
  { id: 'electric_piano', name: 'Electric piano' },
];

// Steps shown while working; a step is "current" when the server's status message contains one of its keys.
const STEPS = {
  swap: [
    { label: 'Trimming the part', keys: ['trimming', 'starting'] },
    { label: 'Separating drums, bass, music and voice', keys: ['separating'] },
    { label: 'Reading the notes of the music', keys: ['reading'] },
    { label: 'Playing them on the new instrument', keys: ['playing'] },
    { label: 'Mixing it back together', keys: ['mixing'] },
  ],
  lofi: [
    { label: 'Trimming the part', keys: ['trimming', 'starting'] },
    { label: 'Removing the voice', keys: ['separating'], needsVoiceRemoval: true },
    { label: 'Adding the lofi feel', keys: ['lofi'] },
  ],
};

const formatTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
};

const stepIndexFor = (message, steps) => {
  const m = (message || '').toLowerCase();
  if (m.includes('cloud') || m.includes('done')) return steps.length;
  let index = 0;
  steps.forEach((s, i) => {
    if (s.keys.some((k) => m.includes(k))) index = i;
  });
  return index;
};

function Check2({ checked, onChange, label, hint, disabled }) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer" title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-indigo-500" />
      <span className="text-sm text-zinc-200">{label}</span>
    </label>
  );
}

export default function RemixStudio({ onBack }) {
  const [file, setFile] = useState(null);
  const [duration, setDuration] = useState(0);
  const [region, setRegion] = useState({ start: 0, end: 0 });
  const [isPlaying, setIsPlaying] = useState(false);

  const [kind, setKind] = useState('swap'); // swap | lofi
  const [instrument, setInstrument] = useState('sitar');
  const [keepDrums, setKeepDrums] = useState(true);
  const [keepBass, setKeepBass] = useState(true);
  const [keepVocals, setKeepVocals] = useState(false);
  const [speed, setSpeed] = useState(0.88);
  const [vinyl, setVinyl] = useState(true);
  const [reverb, setReverb] = useState(true);
  const [lofiRemoveVocals, setLofiRemoveVocals] = useState(false);

  const [phase, setPhase] = useState('idle'); // idle | generating | done | error
  const [jobId, setJobId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');

  // Live tweaks on a finished swap: the separated parts stay on the server, so switching the
  // instrument or the mix afterwards only re-renders that part instead of redoing everything.
  const [mixBlobUrl, setMixBlobUrl] = useState(null);
  const [tweaking, setTweaking] = useState(false);
  const [tweakError, setTweakError] = useState('');
  const tweakSeq = useRef(0);
  useEffect(() => () => { if (mixBlobUrl) URL.revokeObjectURL(mixBlobUrl); }, [mixBlobUrl]);

  const waveRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);

  // ---- Waveform with a draggable window for the part to remix ----
  useEffect(() => {
    if (!file || !waveRef.current) return;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      waveColor: '#4f46e5',
      progressColor: '#818cf8',
      cursorColor: '#e0e7ff',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 72,
      normalize: true,
    });
    const regions = ws.registerPlugin(RegionsPlugin.create());
    wsRef.current = ws;
    ws.on('ready', () => {
      const d = ws.getDuration();
      setDuration(d);
      regionRef.current = regions.addRegion({ start: 0, end: d, color: 'rgba(99, 102, 241, 0.12)', drag: true, resize: true });
      setRegion({ start: 0, end: d });
    });
    regions.on('region-update', (r) => setRegion({ start: r.start, end: r.end }));
    regions.on('region-updated', (r) => setRegion({ start: r.start, end: r.end }));
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    const url = URL.createObjectURL(file);
    ws.load(url).catch(() => {});
    return () => {
      ws.destroy();
      URL.revokeObjectURL(url);
      wsRef.current = null;
      regionRef.current = null;
      setIsPlaying(false);
    };
  }, [file]);

  const togglePlay = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.isPlaying()) ws.pause();
    else if (regionRef.current) regionRef.current.play();
    else ws.play();
  };

  const pickFile = (f) => {
    if (!f) return;
    setFile(f);
    setDuration(0);
    setPhase('idle');
    setError('');
    setTweakError('');
    setMixBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  };

  // ---- Make it ----
  const start = async () => {
    if (!file || phase === 'generating') return;
    wsRef.current?.pause();
    setPhase('generating');
    setStatusMsg('Uploading...');
    setError('');
    setJobId(null);

    const form = new FormData();
    form.append('file', file);
    form.append('start', String(region.start));
    form.append('length', String(region.end - region.start));
    form.append('mode', kind);
    form.append('instrument', instrument);
    form.append('keep_drums', String(keepDrums));
    form.append('keep_bass', String(keepBass));
    form.append('keep_vocals', String(keepVocals));
    form.append('lofi_speed', String(speed));
    form.append('lofi_vinyl', String(vinyl));
    form.append('lofi_reverb', String(reverb));
    form.append('lofi_remove_vocals', String(lofiRemoveVocals));

    try {
      const res = await fetch(`${API}/generate`, { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
      }
      setJobId((await res.json()).job_id);
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  };

  useEffect(() => {
    if (phase !== 'generating' || !jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${API}/status/${jobId}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setStatusMsg(data.message);
        if (data.status === 'failed') {
          setError(data.message);
          setPhase('error');
        } else if (data.status === 'completed') {
          setPhase('done');
        }
      } catch (e) {
        if (!cancelled) console.error('Polling error:', e);
      }
    };
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase, jobId]);

  const steps = STEPS[kind].filter((s) => !s.needsVoiceRemoval || lofiRemoveVocals);
  const activeStep = stepIndexFor(statusMsg, steps);
  const resultUrl = jobId ? `${API}/download/${jobId}` : null;
  const activeUrl = mixBlobUrl || resultUrl;
  const busy = phase === 'generating';

  // Re-mix the already-separated parts at the current levels (music/drums/bass/vocals).
  // `overrides` carries a just-changed value in, since the state setter that triggered this
  // hasn't landed yet when this runs.
  const liveExport = async (overrides = {}) => {
    if (!jobId) return;
    const seq = ++tweakSeq.current;
    setTweaking(true);
    setTweakError('');
    try {
      const res = await fetch(`${API}/remix/${jobId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          music: 1,
          drums: keepDrums ? 1 : 0,
          bass: keepBass ? 1 : 0,
          vocals: keepVocals ? 1 : 0,
          ...overrides,
        }),
      });
      if (!res.ok) throw new Error('Could not update the mix');
      const blob = await res.blob();
      if (seq !== tweakSeq.current) return; // a newer tweak is already in flight
      setMixBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } catch (e) {
      if (seq === tweakSeq.current) setTweakError(e.message);
    } finally {
      if (seq === tweakSeq.current) setTweaking(false);
    }
  };

  const liveChangeInstrument = async (id) => {
    if (!jobId) return;
    setTweaking(true);
    setTweakError('');
    try {
      const res = await fetch(`${API}/remix/${jobId}/instrument`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument: id }),
      });
      if (!res.ok) throw new Error(`Could not switch to ${id}`);
      await liveExport();
    } catch (e) {
      setTweakError(e.message);
      setTweaking(false);
    }
  };

  return (
    <div className="h-[100dvh] w-full bg-[#0f0f11] text-zinc-100 font-sans flex flex-col overflow-hidden">
      <header className="h-12 shrink-0 border-b border-zinc-800 bg-[#111113] flex items-center gap-3 px-4">
        <button onClick={onBack} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" title="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Headphones className="w-4 h-4 text-indigo-400" />
        <span className="text-sm font-semibold">Music Remix</span>
        <span className="text-zinc-700">/</span>
        <span className="text-sm text-zinc-400 truncate">{file ? file.name : 'No song loaded'}</span>
      </header>

      <main className="flex-1 min-h-0 p-4 sm:p-5 flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_340px] gap-5 overflow-y-auto lg:overflow-y-hidden">
        {/* Left: the song, and below it the progress or the result */}
        <div className="min-h-0 flex flex-col gap-5">
          {!file ? (
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); }}
              className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-zinc-700 hover:border-indigo-500/60 rounded-2xl text-center cursor-pointer transition-colors"
            >
              <Upload className="w-9 h-9 text-zinc-600 mb-3" />
              <p className="text-zinc-200 font-medium">Drop a song here or click to choose</p>
              <p className="text-sm text-zinc-500 mt-1">MP3 or WAV, up to 15MB</p>
              <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
            </label>
          ) : (
            <>
              <div className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-zinc-200 truncate">{file.name}</span>
                  <label className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer shrink-0 ml-4">
                    Replace
                    <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
                  </label>
                </div>
                <div ref={waveRef} />
                <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono">
                  <button
                    onClick={togglePlay}
                    className="w-8 h-8 rounded-full bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center transition-colors text-white"
                    title="Play the selected part"
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                  </button>
                  <span>{formatTime(region.start)} – {formatTime(region.end)}</span>
                  <span className="text-zinc-600">·</span>
                  <span>{formatTime(region.end - region.start)} of {formatTime(duration)}</span>
                  <span className="ml-auto font-sans text-[11px] text-zinc-600">Drag the edges of the box to choose the part</span>
                </div>
              </div>

              <div className="flex-1 min-h-0 rounded-xl border border-zinc-800 bg-zinc-900/20 p-5 flex items-center justify-center overflow-y-auto">
                {phase === 'idle' && (
                  <p className="text-sm text-zinc-500 text-center max-w-xs">
                    {kind === 'swap'
                      ? 'Choose the part, pick an instrument on the right, and press the button.'
                      : 'Choose the part, set the lofi feel on the right, and press the button.'}
                  </p>
                )}

                {busy && (
                  <div className="space-y-3">
                    {steps.map((s, i) => {
                      const done = i < activeStep;
                      const active = i === activeStep;
                      return (
                        <div key={s.label} className={`flex items-center gap-3 text-sm ${done ? 'text-emerald-400' : active ? 'text-zinc-100' : 'text-zinc-600'}`}>
                          {done ? <Check className="w-4 h-4" /> : active ? <Loader2 className="w-4 h-4 animate-spin text-indigo-400" /> : <span className="w-4 h-4 rounded-full border border-zinc-700" />}
                          {s.label}
                        </div>
                      );
                    })}
                  </div>
                )}

                {phase === 'error' && (
                  <div className="text-center max-w-md">
                    <p className="text-sm text-rose-300 break-words">Something went wrong: {error}</p>
                    <button onClick={start} className="mt-3 text-xs text-zinc-300 underline hover:text-white">Try again</button>
                  </div>
                )}

                {phase === 'done' && resultUrl && (
                  <div className="w-full max-w-lg space-y-3">
                    {kind === 'swap' && (
                      <div className="flex items-center gap-2 text-xs h-4">
                        {tweaking && (
                          <span className="flex items-center gap-1.5 text-indigo-400">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Updating the mix…
                          </span>
                        )}
                        {!tweaking && tweakError && <span className="text-rose-400">{tweakError}</span>}
                        {!tweaking && !tweakError && mixBlobUrl && (
                          <span className="text-emerald-400">Updated — pick the instrument or the mix on the right anytime.</span>
                        )}
                      </div>
                    )}
                    <audio key={activeUrl} controls className="w-full" src={activeUrl} />
                    <div className="flex gap-3">
                      <a
                        href={activeUrl} download={`${kind === 'swap' ? 'New_instrument' : 'Lofi'}.mp3`} target="_blank" rel="noreferrer"
                        className="flex-1 bg-white hover:bg-zinc-200 text-zinc-900 py-2.5 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        <Download className="w-4 h-4" /> Download MP3
                      </a>
                      <button
                        onClick={() => {
                          setPhase('idle');
                          setJobId(null);
                          setTweakError('');
                          setMixBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
                        }}
                        className="px-5 border border-zinc-700 hover:bg-zinc-800 text-zinc-300 rounded-xl text-sm transition-colors"
                      >
                        Make another
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right: what to make */}
        <aside className="min-h-0 flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-zinc-900 border border-zinc-800">
            {[
              { id: 'swap', label: 'Change instrument', icon: Music },
              { id: 'lofi', label: 'Lofi', icon: Headphones },
            ].map((o) => (
              <button
                key={o.id} onClick={() => setKind(o.id)} disabled={busy}
                className={`py-2 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
                  kind === o.id ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                <o.icon className="w-3.5 h-3.5" /> {o.label}
              </button>
            ))}
          </div>

          {kind === 'swap' ? (
            <div className="space-y-4">
              <div>
                <p className="text-[11px] text-zinc-500 mb-2">
                  New instrument{phase === 'done' && <span className="text-zinc-600"> — tap to try another, instantly</span>}
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {INSTRUMENTS.map((i) => (
                    <button
                      key={i.id}
                      onClick={() => {
                        setInstrument(i.id);
                        if (phase === 'done') liveChangeInstrument(i.id);
                      }}
                      disabled={busy || (phase === 'done' && tweaking)}
                      className={`py-2 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 ${
                        instrument === i.id ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700'
                      }`}
                    >
                      {i.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2.5">
                <Check2
                  checked={keepDrums}
                  onChange={(v) => { setKeepDrums(v); if (phase === 'done') liveExport({ drums: v ? 1 : 0 }); }}
                  disabled={busy || (phase === 'done' && tweaking)}
                  label="Keep the original drums"
                />
                <Check2
                  checked={keepBass}
                  onChange={(v) => { setKeepBass(v); if (phase === 'done') liveExport({ bass: v ? 1 : 0 }); }}
                  disabled={busy || (phase === 'done' && tweaking)}
                  label="Keep the original bass"
                />
                <Check2
                  checked={keepVocals}
                  onChange={(v) => { setKeepVocals(v); if (phase === 'done') liveExport({ vocals: v ? 1 : 0 }); }}
                  disabled={busy || (phase === 'done' && tweaking)}
                  label="Keep the singer's voice"
                  hint="Off means the voice is removed."
                />
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                Drums and bass stay real. The rest of the music is played by a synthesizer on the new instrument, so it sounds like a MIDI version.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <label className="block">
                <div className="flex justify-between text-[11px] text-zinc-500 mb-1.5">
                  <span>Slow down</span>
                  <span className="font-mono text-zinc-300">{Math.round(speed * 100)}%</span>
                </div>
                <input
                  type="range" min={0.7} max={1} step={0.01} value={speed} disabled={busy}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </label>
              <div className="space-y-2.5">
                <Check2 checked={vinyl} onChange={setVinyl} disabled={busy} label="Vinyl / tape noise" />
                <Check2 checked={reverb} onChange={setReverb} disabled={busy} label="Soft room reverb" />
                <Check2 checked={lofiRemoveVocals} onChange={setLofiRemoveVocals} disabled={busy} label="Remove the voice" hint="Instrumental lofi. Takes longer, because the voice has to be separated first." />
              </div>
            </div>
          )}

          <button
            onClick={start} disabled={!file || busy}
            className="mt-auto w-full py-3 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            {busy ? 'Working…' : kind === 'swap' ? 'Change the instrument' : 'Make it lofi'}
          </button>
        </aside>
      </main>
    </div>
  );
}
