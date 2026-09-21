import { useState, useEffect, useMemo, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { ArrowLeft, Upload, Play, Pause, Loader2, Copy, Check, Download, Languages, Scissors, Sparkles, RotateCcw } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const STEPS = [
  { id: 'upload', label: 'Preparing & uploading the selected part' },
  { id: 'isolate', label: 'Separating vocals' },
  { id: 'listen', label: 'Listening to the lyrics' },
  { id: 'hinglish', label: 'Writing in Hinglish' },
];

// Keep in sync with LYRICS_ISOLATE_MAX_SEC in backend/app/services/pipeline.py
const ISOLATE_MAX_SEC = 90;
const POLL_MS = 2000;
const MIN_REGION = 1;

const formatTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
};

const stepIndexFor = (message) => {
  const s = (message || '').toLowerCase();
  if (s.includes('cloud') || s.includes('done')) return STEPS.length;
  if (s.includes('hinglish')) return 3;
  if (s.includes('finding lyrics')) return 2;
  if (s.includes('separating')) return 1;
  return 0;
};

// Keep in sync with MAX_UPLOAD_BYTES in backend/app/config.py
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Mono 16-bit WAV. 22 kHz is plenty for lyrics (about 2.6 MB per minute); very long parts drop to 16 kHz.
const sampleRateFor = (seconds) => (seconds > 300 ? 16000 : 22050);
const wavBytes = (seconds) => 44 + Math.ceil(seconds * sampleRateFor(seconds)) * 2;

function encodeWav(samples, sampleRate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const writeStr = (offset, str) => [...str].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => {
    const v = Math.max(-1, Math.min(1, x));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  });
  return new Blob([view], { type: 'audio/wav' });
}

// Cut [start, end] out of the decoded song, downmix to mono and resample, so only that part is uploaded.
async function cutToWav(decoded, start, end) {
  const seconds = end - start;
  const sampleRate = sampleRateFor(seconds);
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, start, seconds);
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), sampleRate);
}

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

function PanelTitle({ icon: Icon, children }) {
  return (
    <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2 mb-3">
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {children}
    </h2>
  );
}

// Uncontrolled on purpose: the key re-syncs it when the region is dragged, and typing isn't interrupted.
function TimeField({ label, value, disabled, onCommit }) {
  return (
    <label className="flex-1">
      <span className="block text-[10px] text-zinc-500 mb-1">{label}</span>
      <input
        key={value.toFixed(1)}
        type="number" step="0.1" min="0" defaultValue={value.toFixed(1)}
        disabled={disabled}
        onBlur={(e) => onCommit(parseFloat(e.target.value) || 0)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1.5 text-xs font-mono text-zinc-200 disabled:opacity-40 focus:outline-none focus:border-indigo-500"
      />
    </label>
  );
}

export default function LyricsEditor({ onBack }) {
  const [file, setFile] = useState(null);
  const [duration, setDuration] = useState(0);
  const [region, setRegion] = useState({ start: 0, end: 0 });

  const [phase, setPhase] = useState('idle'); // idle | generating | done | error
  const [jobId, setJobId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');
  const [lines, setLines] = useState([]);
  const [genOffset, setGenOffset] = useState(0);
  const [genLength, setGenLength] = useState(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [showTimes, setShowTimes] = useState(true);
  const [copied, setCopied] = useState(false);

  const waveformRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);
  const rowRefs = useRef([]);
  const previewRef = useRef(null);
  const previewRowRefs = useRef([]);

  // ---- Waveform + trim region ----
  useEffect(() => {
    if (!file || !waveformRef.current) return;
    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#4f46e5',
      progressColor: '#818cf8',
      cursorColor: '#e0e7ff',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 88,
      normalize: true,
    });
    const regions = ws.registerPlugin(RegionsPlugin.create());
    wsRef.current = ws;

    ws.on('ready', () => {
      const d = ws.getDuration();
      setDuration(d);
      regionRef.current = regions.addRegion({
        start: 0, end: d, color: 'rgba(99, 102, 241, 0.10)', drag: true, resize: true,
      });
      setRegion({ start: 0, end: d });
    });
    // While the song is playing, moving the window (or its start handle) continues playback
    // from the window's new start; pulling the end handle behind the playhead stops it.
    let lastSeekAt = 0;
    const followWindow = (r, side) => {
      setRegion({ start: r.start, end: r.end });
      if (!ws.isPlaying()) return;
      if (side === 'end') {
        if (ws.getCurrentTime() >= r.end) ws.pause();
      } else {
        ws.setTime(r.start);
      }
    };
    regions.on('region-update', (r, side) => {
      const now = performance.now();
      if (now - lastSeekAt < 100) {
        setRegion({ start: r.start, end: r.end });
        return;
      }
      lastSeekAt = now;
      followWindow(r, side);
    });
    regions.on('region-updated', followWindow);
    ws.on('timeupdate', (t) => {
      setCurrentTime(Math.round(t * 10) / 10);
      const r = regionRef.current;
      if (r && t >= r.end) ws.pause();
    });
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
      setCurrentTime(0);
    };
  }, [file]);

  const applyRegion = (start, end) => {
    const s = Math.min(Math.max(0, start), Math.max(0, duration - MIN_REGION));
    const e = Math.min(duration, Math.max(end, s + MIN_REGION));
    regionRef.current?.setOptions({ start: s, end: e });
    setRegion({ start: s, end: e });
  };

  const togglePlay = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.isPlaying()) {
      ws.pause();
      return;
    }
    const t = ws.getCurrentTime();
    if (t < region.start || t >= region.end - 0.05) ws.setTime(region.start);
    ws.play();
  };

  const seekTo = (songTime) => {
    const ws = wsRef.current;
    if (!ws) return;
    ws.setTime(songTime);
    ws.play();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- Generate + poll ----
  const handleGenerate = async () => {
    if (!file || phase === 'generating') return;
    wsRef.current?.pause();
    setPhase('generating');
    setStatusMsg('Preparing...');
    setError('');
    setLines([]);
    setJobId(null);
    setGenOffset(region.start);
    setGenLength(region.end - region.start);

    try {
      if (wavBytes(region.end - region.start) > MAX_UPLOAD_BYTES) {
        throw new Error('The selected part is too long. Please select less than about 7 minutes.');
      }
      const decoded = wsRef.current?.getDecodedData();
      if (!decoded) throw new Error('The song is still loading. Try again in a moment.');
      const wav = await cutToWav(decoded, region.start, region.end);

      // The selected part is already cut, so the server processes it from 0 to the end.
      const formData = new FormData();
      formData.append('file', wav, `${file.name.replace(/.[^.]+$/, '')}.wav`);
      formData.append('start', '0');
      formData.append('length', '0');
      formData.append('mode', 'lyrics');
      formData.append('language', 'auto');

      const res = await fetch(`${API}/generate`, { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
      }
      const data = await res.json();
      setJobId(data.job_id);
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
          const lr = await fetch(`${API}/reels/${jobId}/lyrics`);
          if (cancelled) return;
          if (!lr.ok) throw new Error('Could not load the transcript');
          setLines(await lr.json());
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

  const pickFile = (f) => {
    if (!f) return;
    setFile(f);
    setPhase('idle');
    setLines([]);
    setError('');
    setDuration(0);
  };

  // ---- Active line ----
  const activeIdx = useMemo(() => {
    const t = currentTime - genOffset;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].start <= t + 0.05) idx = i;
      else break;
    }
    if (idx >= 0 && t > lines[idx].end + 1.5) return -1;
    return idx;
  }, [lines, currentTime, genOffset]);

  useEffect(() => {
    if (activeIdx < 0) return;
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const box = previewRef.current;
    const row = previewRowRefs.current[activeIdx];
    if (box && row) {
      box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2, behavior: 'smooth' });
    }
  }, [activeIdx]);

  // ---- Transcript actions ----
  const transcriptText = () =>
    lines
      .filter((l) => l.text.trim())
      .map((l) => (showTimes ? `[${formatTime(genOffset + l.start)}] ${l.text}` : l.text))
      .join('\n');

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert('Could not copy to the clipboard');
    }
  };

  const downloadTxt = () => {
    const blob = new Blob([transcriptText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(file?.name || 'song').replace(/\.[^.]+$/, '')}_lyrics.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateLineText = (idx, text) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, text } : l)));

  const regionLength = Math.max(0, region.end - region.start);
  const activeStep = stepIndexFor(statusMsg);

  const trimLocked = !file || phase === 'generating';

  return (
    <div className="h-screen w-screen min-w-[1100px] bg-[#0b0b0d] text-zinc-100 font-sans flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="h-12 shrink-0 border-b border-zinc-800 bg-[#111113] flex items-center gap-3 px-3">
        <button onClick={onBack} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" title="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2">
          <Languages className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold">Lyrics Studio</span>
        </div>
        <span className="text-zinc-700">/</span>
        <span className="text-sm text-zinc-400 truncate max-w-md">{file ? file.name : 'No song loaded'}</span>
        <div className="ml-auto flex items-center gap-3">
          {phase === 'generating' && (
            <span className="text-xs text-indigo-300 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Working…</span>
          )}
          {phase === 'done' && <span className="text-xs text-emerald-400">Transcript ready</span>}
          <button
            onClick={handleGenerate}
            disabled={!file || phase === 'generating'}
            className="px-4 py-1.5 rounded-md text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            {phase === 'done' ? 'Regenerate' : 'Generate lyrics'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left: inspector */}
        <aside className="w-72 shrink-0 border-r border-zinc-800 bg-[#0f0f11] overflow-y-auto p-4 space-y-6">
          <section>
            <PanelTitle icon={Upload}>Source</PanelTitle>
            {file ? (
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-3">
                <p className="text-sm text-zinc-200 truncate" title={file.name}>{file.name}</p>
                <p className="text-xs text-zinc-500 mt-1">
                  {(file.size / 1024 / 1024).toFixed(1)} MB{duration ? ` · ${formatTime(duration)}` : ''}
                </p>
                <label className="mt-3 inline-block text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer">
                  Replace song
                  <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
                </label>
              </div>
            ) : (
              <label className="block text-center text-sm text-zinc-400 border border-dashed border-zinc-700 hover:border-indigo-500/60 rounded-lg py-6 cursor-pointer transition-colors">
                Choose a song
                <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
              </label>
            )}
          </section>

          <section>
            <PanelTitle icon={Scissors}>Trim</PanelTitle>
            <div className="flex gap-2">
              <TimeField label="Start (s)" value={region.start} disabled={trimLocked} onCommit={(v) => applyRegion(v, region.end)} />
              <TimeField label="End (s)" value={region.end} disabled={trimLocked} onCommit={(v) => applyRegion(region.start, v)} />
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              Selected: <span className="text-zinc-300 font-mono">{formatTime(regionLength)}</span>. Drag the edges on the timeline. Up to {ISOLATE_MAX_SEC}s the vocals are separated first, which gives better lyrics but takes about a minute.
            </p>
          </section>
        </aside>

        {/* Center: preview + timeline */}
        <main className="flex-1 min-w-0 flex flex-col">
          <div className={`flex-1 min-h-0 flex items-center justify-center bg-gradient-to-b from-[#101014] to-[#0b0b0d] ${phase === 'done' && lines.length > 0 ? '' : 'p-8'}`}>
            {!file ? (
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); }}
                className="w-full max-w-xl border-2 border-dashed border-zinc-700 hover:border-indigo-500/60 rounded-2xl p-16 text-center cursor-pointer transition-colors"
              >
                <Upload className="w-10 h-10 text-zinc-600 mx-auto mb-4" />
                <p className="text-zinc-200 font-medium">Drop a song here or click to choose</p>
                <p className="text-sm text-zinc-500 mt-1">MP3 or WAV</p>
                <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
              </label>
            ) : phase === 'generating' ? (
              <div className="w-full max-w-sm space-y-3">
                {STEPS.filter((s) => s.id !== 'isolate' || genLength <= ISOLATE_MAX_SEC).map((s) => {
                  const idx = STEPS.indexOf(s);
                  const done = idx < activeStep;
                  const active = idx === activeStep;
                  return (
                    <div key={s.id} className={`flex items-center gap-3 text-sm ${done ? 'text-emerald-400' : active ? 'text-zinc-100' : 'text-zinc-600'}`}>
                      {done ? <Check className="w-4 h-4" /> : active ? <Loader2 className="w-4 h-4 animate-spin text-indigo-400" /> : <span className="w-4 h-4 rounded-full border border-zinc-700" />}
                      {s.label}
                    </div>
                  );
                })}
              </div>
            ) : phase === 'error' ? (
              <div className="text-center max-w-md">
                <p className="text-rose-400 font-medium mb-2">Something went wrong</p>
                <p className="text-sm text-zinc-400 mb-4 break-words">{error}</p>
                <button onClick={handleGenerate} className="px-4 py-2 rounded-md text-sm border border-zinc-700 hover:bg-zinc-800 transition-colors inline-flex items-center gap-2">
                  <RotateCcw className="w-4 h-4" /> Try again
                </button>
              </div>
            ) : phase === 'done' && lines.length > 0 ? (
              <div ref={previewRef} className="relative w-full h-full overflow-y-auto text-center">
                <div className="max-w-3xl mx-auto py-[30vh] px-4 space-y-5">
                  {lines.map((l, i) => {
                    const isActive = i === activeIdx;
                    return (
                      <p
                        key={i}
                        ref={(el) => { previewRowRefs.current[i] = el; }}
                        onClick={() => seekTo(genOffset + l.start)}
                        className={`cursor-pointer transition-all duration-200 leading-snug break-words ${
                          isActive ? 'text-4xl font-semibold text-amber-300' : 'text-xl text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {l.text || '…'}
                      </p>
                    );
                  })}
                </div>
              </div>
            ) : phase === 'done' ? (
              <p className="text-zinc-500 text-sm">No lyrics were detected in this part. Try another part of the song.</p>
            ) : (
              <div className="text-center">
                <p className="text-zinc-300 font-medium">Pick the part you want, then press “Generate lyrics”.</p>
                <p className="text-sm text-zinc-500 mt-1">Press Space to play. Drag the edges on the timeline to trim.</p>
              </div>
            )}
          </div>

          {/* Transport */}
          <div className="h-12 shrink-0 border-t border-zinc-800 bg-[#111113] flex items-center gap-4 px-4">
            <button
              onClick={togglePlay} disabled={!file}
              className="w-8 h-8 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 flex items-center justify-center transition-colors"
              title="Play / pause (Space)"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>
            <span className="font-mono text-xs text-zinc-300">{formatTime(currentTime)}</span>
            <span className="font-mono text-xs text-zinc-600">/ {formatTime(duration)}</span>
            <span className="ml-auto text-xs text-zinc-500">
              Playing {formatTime(region.start)} – {formatTime(region.end)}
            </span>
          </div>

          {/* Timeline */}
          <div className="h-48 shrink-0 border-t border-zinc-800 bg-[#0f0f11] px-4 py-3">
            <PanelTitle>Timeline</PanelTitle>
            <div className="relative">
              <div ref={waveformRef} className={file ? '' : 'opacity-0 h-[88px]'} />
              {!file && (
                <div className="absolute inset-0 h-[88px] border border-dashed border-zinc-800 rounded-md flex items-center justify-center text-xs text-zinc-600">
                  The waveform appears here
                </div>
              )}
            </div>
            {/* Lyric track, aligned to the waveform above */}
            <div className="relative h-8 mt-2 bg-zinc-900/60 border border-zinc-800 rounded-md overflow-hidden">
              {duration > 0 && lines.map((l, i) => (
                <button
                  key={i}
                  onClick={() => seekTo(genOffset + l.start)}
                  title={l.text}
                  style={{
                    left: `${((genOffset + l.start) / duration) * 100}%`,
                    width: `${Math.max(((l.end - l.start) / duration) * 100, 0.4)}%`,
                  }}
                  className={`absolute top-1 bottom-1 rounded px-1 text-[10px] leading-6 truncate text-left transition-colors ${
                    i === activeIdx ? 'bg-amber-400/90 text-zinc-900' : 'bg-indigo-500/40 text-indigo-100 hover:bg-indigo-500/60'
                  }`}
                >
                  {l.text}
                </button>
              ))}
              {duration > 0 && (
                <div className="absolute top-0 bottom-0 w-px bg-white/70 pointer-events-none" style={{ left: `${(currentTime / duration) * 100}%` }} />
              )}
              {lines.length === 0 && (
                <span className="absolute inset-0 flex items-center px-3 text-[11px] text-zinc-600">Lyrics track</span>
              )}
            </div>
          </div>
        </main>

        {/* Right: transcript */}
        <aside className="w-96 shrink-0 border-l border-zinc-800 bg-[#0f0f11] flex flex-col min-h-0">
          <div className="shrink-0 p-4 border-b border-zinc-800">
            <div className="flex items-center justify-between">
              <PanelTitle>Transcript · Hinglish</PanelTitle>
              <span className="text-xs text-zinc-600 -mt-3">{lines.length} lines</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={copyAll} disabled={!lines.length}
                className="flex-1 py-1.5 rounded-md text-xs border border-zinc-800 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex items-center justify-center gap-1.5"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={downloadTxt} disabled={!lines.length}
                className="flex-1 py-1.5 rounded-md text-xs border border-zinc-800 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex items-center justify-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" /> .txt
              </button>
              <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer pl-1">
                <input type="checkbox" checked={showTimes} onChange={(e) => setShowTimes(e.target.checked)} className="accent-indigo-500" />
                Times
              </label>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            {lines.length === 0 ? (
              <p className="text-sm text-zinc-600 p-4">
                {phase === 'generating' ? 'Working on it…' : 'The lyrics will appear here. You can fix any word by clicking on it.'}
              </p>
            ) : (
              lines.map((l, i) => (
                <div
                  key={i}
                  ref={(el) => { rowRefs.current[i] = el; }}
                  className={`flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors ${i === activeIdx ? 'bg-amber-400/10' : 'hover:bg-zinc-900/60'}`}
                >
                  <button
                    onClick={() => seekTo(genOffset + l.start)}
                    className={`shrink-0 mt-1.5 font-mono text-[11px] hover:text-white ${i === activeIdx ? 'text-amber-300' : 'text-zinc-500'}`}
                    title="Play from here"
                  >
                    {formatTime(genOffset + l.start)}
                  </button>
                  <textarea
                    rows={2}
                    value={l.text}
                    onChange={(e) => updateLineText(i, e.target.value)}
                    className={`flex-1 min-w-0 resize-none bg-transparent text-sm leading-snug rounded px-1.5 py-1 focus:outline-none focus:bg-zinc-900 ${i === activeIdx ? 'text-amber-200' : 'text-zinc-200'}`}
                  />
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
