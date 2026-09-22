import { useState, useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { ArrowLeft, Upload, Play, Pause, Loader2, Download, Check, Drama } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const POLL_MS = 2000;

const CHARACTERS = [
  { id: 'chipmunk', name: 'Chipmunk' },
  { id: 'giant', name: 'Giant' },
  { id: 'robot', name: 'Robot' },
  { id: 'demon', name: 'Demon' },
  { id: 'ghost', name: 'Ghost' },
  { id: 'alien', name: 'Alien' },
  { id: 'kid', name: 'Kid' },
  { id: 'old_man', name: 'Old man' },
  { id: 'fairy', name: 'Fairy' },
];

const STEPS = [
  { label: 'Trimming the part', keys: ['trimming', 'starting'] },
  { label: 'Separating the singer from the music', keys: ['separating'] },
  { label: 'Turning the voice into the character', keys: ['turning'] },
  { label: 'Mixing it back together', keys: ['mixing'] },
];

const formatTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  return `${m}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
};

const stepIndexFor = (message) => {
  const m = (message || '').toLowerCase();
  if (m.includes('cloud') || m.includes('done')) return STEPS.length;
  let index = 0;
  STEPS.forEach((s, i) => {
    if (s.keys.some((k) => m.includes(k))) index = i;
  });
  return index;
};

export default function VoiceChanger({ onBack }) {
  const [file, setFile] = useState(null);
  const [duration, setDuration] = useState(0);
  const [region, setRegion] = useState({ start: 0, end: 0 });
  const [isPlaying, setIsPlaying] = useState(false);

  const [character, setCharacter] = useState('chipmunk');

  const [phase, setPhase] = useState('idle'); // idle | generating | done | error
  const [jobId, setJobId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');

  const waveRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);

  // ---- Waveform with a draggable window for the part to convert ----
  useEffect(() => {
    if (!file || !waveRef.current) return;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      waveColor: '#a855f7',
      progressColor: '#d8b4fe',
      cursorColor: '#f3e8ff',
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
      regionRef.current = regions.addRegion({ start: 0, end: d, color: 'rgba(168, 85, 247, 0.12)', drag: true, resize: true });
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
    form.append('mode', 'voice');
    form.append('voice_character', character);

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

  const activeStep = stepIndexFor(statusMsg);
  const resultUrl = jobId ? `${API}/download/${jobId}` : null;
  const busy = phase === 'generating';

  return (
    <div className="h-[100dvh] w-full bg-[#0f0f11] text-zinc-100 font-sans flex flex-col overflow-hidden">
      <header className="h-12 shrink-0 border-b border-zinc-800 bg-[#111113] flex items-center gap-3 px-4">
        <button onClick={onBack} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" title="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Drama className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-semibold">Voice Changer</span>
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
              className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-zinc-700 hover:border-violet-500/60 rounded-2xl text-center cursor-pointer transition-colors"
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
                  <label className="text-xs text-violet-400 hover:text-violet-300 cursor-pointer shrink-0 ml-4">
                    Replace
                    <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
                  </label>
                </div>
                <div ref={waveRef} />
                <div className="flex items-center gap-3 text-xs text-zinc-400 font-mono">
                  <button
                    onClick={togglePlay}
                    className="w-8 h-8 rounded-full bg-violet-600 hover:bg-violet-500 flex items-center justify-center transition-colors text-white"
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
                    Choose the part, pick a character on the right, and press the button.
                  </p>
                )}

                {busy && (
                  <div className="space-y-3">
                    {STEPS.map((s, i) => {
                      const done = i < activeStep;
                      const active = i === activeStep;
                      return (
                        <div key={s.label} className={`flex items-center gap-3 text-sm ${done ? 'text-emerald-400' : active ? 'text-zinc-100' : 'text-zinc-600'}`}>
                          {done ? <Check className="w-4 h-4" /> : active ? <Loader2 className="w-4 h-4 animate-spin text-violet-400" /> : <span className="w-4 h-4 rounded-full border border-zinc-700" />}
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
                    <audio key={resultUrl} controls className="w-full" src={resultUrl} />
                    <div className="flex gap-3">
                      <a
                        href={resultUrl} download="Character_voice.mp3" target="_blank" rel="noreferrer"
                        className="flex-1 bg-white hover:bg-zinc-200 text-zinc-900 py-2.5 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        <Download className="w-4 h-4" /> Download MP3
                      </a>
                      <button
                        onClick={() => { setPhase('idle'); setJobId(null); }}
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

        {/* Right: which character to become */}
        <aside className="min-h-0 flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 overflow-y-auto">
          <div>
            <p className="text-[11px] text-zinc-500 mb-2">Character</p>
            <div className="grid grid-cols-3 gap-1.5">
              {CHARACTERS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCharacter(c.id)}
                  disabled={busy}
                  className={`py-2 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 ${
                    character === c.id ? 'border-violet-500 bg-violet-500/10 text-violet-300' : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-600">
            The singer is separated from the music, their voice is reshaped into the chosen character, then mixed back with the original music underneath.
          </p>

          <button
            onClick={start} disabled={!file || busy}
            className="mt-auto w-full py-3 rounded-xl text-sm font-medium bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Drama className="w-4 h-4" />}
            {busy ? 'Working…' : 'Change the voice'}
          </button>
        </aside>
      </main>
    </div>
  );
}
