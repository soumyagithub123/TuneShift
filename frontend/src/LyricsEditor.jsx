import { useState, useEffect, useMemo, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { FONTS, loadFont } from './clip/fonts';
import { ANIMATIONS, DEFAULT_CLIP, SIZES, drawClipFrame } from './clip/clipRenderer';
import { canRecord, recordClip } from './clip/recordClip';
import { ArrowLeft, Upload, Play, Pause, Loader2, Check, Download, Languages, Scissors, Sparkles, RotateCcw, Plus, X, Film, Image as ImageIcon, ChevronDown, ArrowUp, Maximize, Minimize } from 'lucide-react';

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
const HOOK_SAMPLE_RATE = 11025; // the hook analysis only needs a small mono copy of the song
const HOOK_KEY = '30'; // which hook length the timeline dots come from
const HOOK_PREVIEW_SEC = 15; // how long a click on a hook dot plays
const MIN_REGION = 1;
const MIN_LINE = 0.3; // shortest a lyric line can be made on the timeline
const clampTo = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

const PANEL_DEFAULT = { left: 320, right: 384 };
const PANEL_LIMITS = { left: [240, 520], right: [280, 560] }; // [min, max] width in px
const PANEL_CENTER_MIN = 420;

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

function encodeWav(channels, sampleRate) {
  const frames = channels[0].length;
  const n = channels.length;
  const view = new DataView(new ArrayBuffer(44 + frames * n * 2));
  const writeStr = (offset, str) => [...str].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + frames * n * 2, true);
  writeStr(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, n, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * n * 2, true);
  view.setUint16(32, n * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, frames * n * 2, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(44 + (i * n + c) * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

// Cut [start, end] out of the decoded song, downmix to mono and resample, so only that part is uploaded.
async function cutToWav(decoded, start, end, sampleRate = sampleRateFor(end - start)) {
  const seconds = end - start;
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, start, seconds);
  const rendered = await offline.startRendering();
  return encodeWav([rendered.getChannelData(0)], sampleRate);
}

// The same cut at the original quality (rate and channels), used to play back just the generated part.
async function cutForPlayback(decoded, start, end) {
  const seconds = end - start;
  const offline = new OfflineAudioContext(decoded.numberOfChannels, Math.ceil(seconds * decoded.sampleRate), decoded.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, start, seconds);
  const rendered = await offline.startRendering();
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, i) => rendered.getChannelData(i));
  return encodeWav(channels, rendered.sampleRate);
}

// "Song (part).wav" / "Song (karaoke).wav" -> "Song"
const baseNameOf = (name) => name.replace(/\.[^.]+$/, '').replace(/ \((part|karaoke)\)$/, '');

// Remove the voice from a generated part: send the part at full quality, wait for the server
// to separate it (roughly as long as the part itself), then fetch the music-only file.
const SEPARATE_POLL_MS = 3000;
const SEPARATE_MAX_POLLS = 600;

async function makeKaraoke(id, partFile) {
  const body = new FormData();
  body.append('file', partFile, 'part.wav');
  const start = await fetch(`${API}/reels/${id}/separate`, { method: 'POST', body });
  if (!start.ok) {
    const err = await start.json().catch(() => ({}));
    throw new Error(typeof err.detail === 'string' ? err.detail : `Request failed (${start.status})`);
  }
  for (let i = 0; i < SEPARATE_MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, SEPARATE_POLL_MS));
    const status = await (await fetch(`${API}/status/${id}`)).json();
    if (status.status === 'failed') throw new Error(status.message);
    if (status.status === 'completed') {
      const res = await fetch(`${API}/reels/${id}/instrumental`);
      if (!res.ok) throw new Error('the music-only version could not be loaded');
      return new File([await res.blob()], `${baseNameOf(partFile.name)} (karaoke).wav`, { type: 'audio/wav' });
    }
  }
  throw new Error('it took too long');
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

// A compact dropdown. Options can carry a style, so a font shows up in its own typeface.
// `compact` puts the label inside the button, for a flat toolbar.
function Dropdown({ label, value, options, onChange, disabled, compact }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <div ref={ref} className="relative min-w-0">
      {!compact && <p className="text-[10px] text-zinc-500 mb-1">{label}</p>}
      <button
        onClick={() => setOpen((o) => !o)} disabled={disabled}
        className={`flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:border-zinc-700 disabled:opacity-50 transition-colors ${
          compact ? 'px-2.5 py-1.5 text-xs' : 'w-full px-2.5 py-2 text-sm'
        }`}
      >
        {compact && <span className="text-zinc-500 shrink-0">{label}</span>}
        <span className="truncate" style={current.style}>{compact ? current.short ?? current.label : current.label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
      </button>
      {open && (
        <div className={`absolute z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-zinc-700 bg-[#18181b] shadow-xl py-1 ${compact ? 'left-0 min-w-[12rem]' : 'left-0 right-0'}`}>
          {options.map((o) => (
            <button
              key={o.value} style={o.style}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`w-full text-left px-2.5 py-1.5 text-sm hover:bg-zinc-800 ${o.value === value ? 'text-indigo-300' : 'text-zinc-300'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SIZE_OPTIONS = [
  { value: '9:16', short: '9:16', label: '9:16 · Reels, Stories' },
  { value: '4:5', short: '4:5', label: '4:5 · Feed post' },
  { value: '1:1', short: '1:1', label: '1:1 · Square' },
  { value: '16:9', short: '16:9', label: '16:9 · Landscape' },
];
const FONT_OPTIONS = FONTS.map((f) => ({ value: f.id, label: f.label, style: { fontFamily: `"${f.family}"`, fontWeight: f.weight } }));
const ANIMATION_OPTIONS = ANIMATIONS.map((a) => ({ value: a.id, label: a.label }));
const STYLE_OPTIONS = [
  { value: 'highlight', label: 'Word highlight' },
  { value: 'plain', label: 'Plain' },
];

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <label className="block">
      <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
        <span>{label}</span>
        <span className="font-mono text-zinc-400">{format ? format(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-indigo-500"
      />
    </label>
  );
}

// Uncontrolled on purpose: the key re-syncs it when the region is dragged, and typing isn't interrupted.
// A thin drag bar on the edge between two panels. Double-click puts the panel back to its normal width.
function PanelResizer({ onStart, onMove, onEnd, onReset }) {
  return (
    <div className="relative w-0 z-20">
      <div
        onPointerDown={onStart} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd} onDoubleClick={onReset}
        className="absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none hover:bg-indigo-500/40 active:bg-indigo-500/60 transition-colors"
        title="Drag to change the width (double-click to reset)"
      />
    </div>
  );
}

function TimeField({ label, value, disabled, onCommit }) {
  return (
    <label className="block min-w-0">
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

// `auto` is "Hook to Reel": once a song is chosen, the best part, the lyrics and a picture are made for the user.
export default function LyricsEditor({ onBack, auto = false }) {
  const [file, setFile] = useState(null);
  const [autoStep, setAutoStep] = useState(null); // hook | choose | go | lyrics | image | done (null when not running)
  const [hookLen, setHookLen] = useState(HOOK_KEY); // which hook length is offered
  // Hook to Reel shows a small guided screen on top of the studio until the reel is made. The studio stays
  // underneath (it holds the player and the drawing) and is shown once the reel is ready.
  const wizard = auto && autoStep !== 'done';
  const [duration, setDuration] = useState(0);
  const [region, setRegion] = useState({ start: 0, end: 0 });

  const [phase, setPhase] = useState('idle'); // idle | generating | done | error
  const [jobId, setJobId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');
  const [lines, setLines] = useState([]);
  const partFileRef = useRef(null); // the selected part at full quality, shown once it has been generated
  const [originalFile, setOriginalFile] = useState(null);
  const [removeVoice, setRemoveVoice] = useState(false);
  const removeVoiceRef = useRef(false); // read from the polling callback
  const [separating, setSeparating] = useState(false);
  const instrumentalFileRef = useRef(null); // the music-only version of the generated part
  const [hooks, setHooks] = useState(null); // { '15': [...], '30': [...], '60': [...] } from the backend
  const [hookState, setHookState] = useState('idle'); // idle | finding | ready | failed
  const hooksForRef = useRef(null); // { file, data } so a song is only analysed once
  const hookRun = useRef(0); // ignores an answer for a song that is no longer loaded
  const [genLength, setGenLength] = useState(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  // Reel clip: the picture, how the lyrics look, and the export
  const [chat, setChat] = useState([]); // the picture "conversation": uploads, descriptions and drawn pictures
  const chatRef = useRef(null); // the message list, to keep the newest message in view
  const chatUrlsRef = useRef([]); // picture URLs to free when the editor closes
  const [adjustOpen, setAdjustOpen] = useState(false);
  const adjustRef = useRef(null);
  const [imageFile, setImageFile] = useState(null);
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const [clip, setClip] = useState(DEFAULT_CLIP);
  const [centerTab, setCenterTab] = useState('lyrics'); // lyrics | clip
  const [exportState, setExportState] = useState(null); // { stage, fraction, seconds, total } while a video is made
  const exportAbortRef = useRef(null);
  const imageElRef = useRef(null); // the picture as an <img>, for drawing on the canvas
  const previewCanvasRef = useRef(null);
  const clipBoxRef = useRef(null); // the clip preview and its controls, the part that goes full screen
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Widths of the side panels. Dragging their edges changes them; they are remembered in this browser.
  const [panelW, setPanelW] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('lyrics-panel-widths'));
      return {
        left: clampTo(Number(saved?.left) || PANEL_DEFAULT.left, PANEL_LIMITS.left[0], PANEL_LIMITS.left[1]),
        right: clampTo(Number(saved?.right) || PANEL_DEFAULT.right, PANEL_LIMITS.right[0], PANEL_LIMITS.right[1]),
      };
    } catch {
      return { ...PANEL_DEFAULT };
    }
  });
  const resizeRef = useRef(null);
  useEffect(() => {
    try {
      localStorage.setItem('lyrics-panel-widths', JSON.stringify(panelW));
    } catch { /* remembering the widths is optional */ }
  }, [panelW]);
  const startResize = (side) => (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { side, startX: e.clientX, startW: panelW[side] };
  };
  const moveResize = (e) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.startX;
    const [lo, hi] = PANEL_LIMITS[r.side];
    const other = panelW[r.side === 'left' ? 'right' : 'left'];
    const room = window.innerWidth - other - PANEL_CENTER_MIN; // the centre always keeps some width
    const w = clampTo(r.side === 'left' ? r.startW + dx : r.startW - dx, lo, Math.min(hi, room));
    setPanelW((p) => ({ ...p, [r.side]: w }));
  };
  const endResize = () => {
    resizeRef.current = null;
  };
  const resetPanel = (side) => () => setPanelW((p) => ({ ...p, [side]: PANEL_DEFAULT[side] }));

  const waveformRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);
  const rowRefs = useRef([]);
  const textRefs = useRef([]);
  const pendingFocus = useRef(null);
  const previewRef = useRef(null);
  const previewEndRef = useRef(null); // set while a hook dot is being auditioned
  const trackRef = useRef(null); // the lyric track, to turn pixels into seconds
  const dragRef = useRef(null); // the lyric block that is being dragged
  const viewOffsetRef = useRef(0); // where the loaded audio starts inside the full song
  const nextViewRef = useRef(null); // the part (in full-song seconds) that is being generated
  const lastPartRef = useRef(null); // the part that was generated last, in full-song seconds
  const restoreRegionRef = useRef(null); // window to put back when the full song is shown again
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
      height: 60,
      normalize: true,
    });
    const regions = ws.registerPlugin(RegionsPlugin.create());
    wsRef.current = ws;

    ws.on('ready', () => {
      const d = ws.getDuration();
      setDuration(d);
      const restore = restoreRegionRef.current;
      restoreRegionRef.current = null;
      const start = restore ? Math.min(restore.start, Math.max(0, d - MIN_REGION)) : 0;
      const end = restore ? Math.min(restore.end, d) : d;
      regionRef.current = regions.addRegion({
        start, end, color: 'rgba(99, 102, 241, 0.10)', drag: true, resize: true,
      });
      setRegion({ start, end });
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
      const previewEnd = previewEndRef.current;
      if (previewEnd !== null) {
        if (t >= previewEnd) {
          ws.pause();
          previewEndRef.current = null;
        }
        return;
      }
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
    previewEndRef.current = null;
    const t = ws.getCurrentTime();
    if (t < region.start || t >= region.end - 0.05) ws.setTime(region.start);
    ws.play();
  };

  const previewHook = (start) => {
    const ws = wsRef.current;
    if (!ws) return;
    previewEndRef.current = start + HOOK_PREVIEW_SEC;
    ws.setTime(start);
    ws.play();
  };

  const seekTo = (songTime) => {
    const ws = wsRef.current;
    if (!ws) return;
    previewEndRef.current = null;
    ws.setTime(songTime);
    ws.play();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space' && !wizard && !isTyping(e.target)) {
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
    nextViewRef.current = {
      start: viewOffsetRef.current + region.start,
      end: viewOffsetRef.current + region.end,
    };
    setPhase('generating');
    setStatusMsg('Preparing...');
    setError('');
    setLines([]);
    setJobId(null);
    setGenLength(region.end - region.start);

    try {
      if (wavBytes(region.end - region.start) > MAX_UPLOAD_BYTES) {
        throw new Error('The selected part is too long. Please select less than about 7 minutes.');
      }
      let decoded = wsRef.current?.getDecodedData();
      if (file === instrumentalFileRef.current && partFileRef.current) {
        // The karaoke version has no voice to transcribe, so cut from the original part instead.
        decoded = await new AudioContext().decodeAudioData(await partFileRef.current.arrayBuffer());
      }
      if (!decoded) throw new Error('The song is still loading. Try again in a moment.');
      const wav = await cutToWav(decoded, region.start, region.end);

      // The selected part is already cut, so the server processes it from 0 to the end.
      const formData = new FormData();
      formData.append('file', wav, `${baseNameOf(file.name)}.wav`);
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
      const part = await cutForPlayback(decoded, region.start, region.end);
      partFileRef.current = new File([part], `${baseNameOf(file.name)} (part).wav`, { type: 'audio/wav' });
      instrumentalFileRef.current = null;
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
          // From here on only the generated part is shown; another part means a new generate.
          if (partFileRef.current) {
            const part = partFileRef.current;
            lastPartRef.current = nextViewRef.current;
            viewOffsetRef.current = nextViewRef.current?.start ?? 0;
            setFile(part);
            if (removeVoiceRef.current) {
              setSeparating(true);
              makeKaraoke(jobId, part)
                .then((karaoke) => {
                  instrumentalFileRef.current = karaoke;
                  if (removeVoiceRef.current) setFile(karaoke);
                })
                .catch((e) => {
                  setRemoveVoice(false);
                  removeVoiceRef.current = false;
                  alert(`Could not remove the voice: ${e.message}`);
                })
                .finally(() => setSeparating(false));
            }
          }
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

  // Before generating this only sets a preference; afterwards it removes the voice (once, this takes
  // a while) or switches back and forth between the original and the music-only version.
  const changeRemoveVoice = async (on) => {
    setRemoveVoice(on);
    removeVoiceRef.current = on;
    if (phase !== 'done' || !partFileRef.current || !jobId) return;
    if (!on) {
      setFile(partFileRef.current);
      return;
    }
    if (instrumentalFileRef.current) {
      setFile(instrumentalFileRef.current);
      return;
    }
    setSeparating(true);
    try {
      instrumentalFileRef.current = await makeKaraoke(jobId, partFileRef.current);
      if (removeVoiceRef.current) setFile(instrumentalFileRef.current);
    } catch (e) {
      setRemoveVoice(false);
      removeVoiceRef.current = false;
      alert(`Could not remove the voice: ${e.message}`);
    } finally {
      setSeparating(false);
    }
  };

  // Find the hooks as soon as a full song has loaded. They are only shown as dots on the timeline;
  // the user decides where to trim.
  useEffect(() => {
    if (!file || !duration || file !== originalFile) return;
    if (hooksForRef.current?.file === file) return;
    const decoded = wsRef.current?.getDecodedData();
    if (!decoded) return;
    const run = ++hookRun.current;
    setHookState('finding');
    (async () => {
      try {
        const wav = await cutToWav(decoded, 0, decoded.duration, HOOK_SAMPLE_RATE);
        const body = new FormData();
        body.append('file', wav, 'song.wav');
        const res = await fetch(`${API}/analyze/hook`, { method: 'POST', body });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = await res.json();
        if (run !== hookRun.current) return;
        hooksForRef.current = { file, data };
        setHooks(data);
        setHookState('ready');
      } catch {
        if (run === hookRun.current) setHookState('failed');
      }
    })();
  }, [file, duration, originalFile]);

  const backToFullSong = () => {
    if (lines.length > 0 && !window.confirm('Going back clears the lyrics. Continue?')) return;
    restoreRegionRef.current = lastPartRef.current;
    setAutoStep(auto ? 'choose' : null);
    setCenterTab('lyrics');
    viewOffsetRef.current = 0;
    setFile(originalFile);
    setPhase('idle');
    setLines([]);
    setError('');
  };

  const pickFile = (f) => {
    if (!f) return;
    setAutoStep(auto ? 'hook' : null);
    setOriginalFile(f);
    viewOffsetRef.current = 0;
    lastPartRef.current = null;
    restoreRegionRef.current = null;
    hooksForRef.current = null;
    setHooks(null);
    setHookState('idle');
    setFile(f);
    setPhase('idle');
    setLines([]);
    setError('');
    setDuration(0);
  };

  // ---- Active line ----
  const activeIdx = useMemo(() => {
    const t = currentTime;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].start <= t + 0.05) idx = i;
      else break;
    }
    if (idx >= 0 && t > lines[idx].end + 1.5) return -1;
    return idx;
  }, [lines, currentTime]);

  useEffect(() => {
    if (activeIdx < 0) return;
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const box = previewRef.current;
    const row = previewRowRefs.current[activeIdx];
    if (box && row) {
      box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2, behavior: 'smooth' });
    }
  }, [activeIdx]);

  // ---- Reel clip ----
  // Any change to the look switches the centre to the live preview so it can be seen at once.
  const setClipOpt = (patch) => {
    setClip((c) => ({ ...c, ...patch }));
    setCenterTab('clip');
  };

  // Drag the text on the preview to place it anywhere; double-click puts it back.
  const textDragRef = useRef(null);
  const canvasPoint = (e) => {
    const canvas = previewCanvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / canvas.height;
    let w = rect.width;
    let h = rect.height;
    if (w / h > ratio) w = h * ratio; // the canvas is drawn "contain", so there can be empty bands
    else h = w / ratio;
    return {
      x: (e.clientX - rect.left - (rect.width - w) / 2) / w,
      y: (e.clientY - rect.top - (rect.height - h) / 2) / h,
    };
  };
  const startTextDrag = (e) => {
    const point = canvasPoint(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    textDragRef.current = { dx: clip.posX - point.x, dy: clip.posY - point.y };
  };
  const moveText = (e) => {
    const drag = textDragRef.current;
    if (!drag) return;
    const point = canvasPoint(e);
    let x = clampTo(point.x + drag.dx, 0.05, 0.95);
    const y = clampTo(point.y + drag.dy, 0.05, 0.95);
    if (Math.abs(x - 0.5) < 0.02) x = 0.5; // sticks to the centre
    setClip((c) => ({ ...c, posX: x, posY: y }));
  };
  const endTextDrag = () => {
    textDragRef.current = null;
  };
  const resetTextPosition = () => setClip((c) => ({ ...c, posX: DEFAULT_CLIP.posX, posY: DEFAULT_CLIP.posY }));

  // Full screen for the clip preview (Esc leaves it). The state follows the browser, so Esc keeps the button right.
  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement === clipBoxRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else clipBoxRef.current?.requestFullscreen?.().catch(() => {});
  };

  const imagePreview = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : null), [imageFile]);
  useEffect(() => () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
  }, [imagePreview]);

  // The picture as an <img> the canvas can draw.
  useEffect(() => {
    if (!imagePreview) {
      imageElRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => { imageElRef.current = img; };
    img.src = imagePreview;
  }, [imagePreview]);

  // A canvas cannot draw with a font that is not loaded yet.
  useEffect(() => {
    loadFont(FONTS.find((f) => f.id === clip.font) ?? FONTS[0]);
  }, [clip.font]);

  // Live preview: redraw on every frame from the player's position, so every change shows at once.
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (centerTab !== 'clip' || !canvas) return;
    const ctx = canvas.getContext('2d');
    const shown = lines.filter((l) => l.text.trim());
    let frame;
    const draw = () => {
      const ws = wsRef.current;
      let t = ws?.getCurrentTime() ?? 0;
      // Paused before the first line: show the first line, so the look can be judged.
      if (ws && !ws.isPlaying() && shown.length && t < shown[0].start) t = shown[0].start + 0.9;
      drawClipFrame(ctx, canvas.width, canvas.height, t, shown, imageElRef.current, clip);
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [centerTab, lines, clip]);

  const errorText = async (res) => {
    const body = await res.json().catch(() => ({}));
    return typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`;
  };

  const chatId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const pickImage = (picked) => {
    setImageFile(picked);
    setCenterTab('clip');
  };

  // An uploaded picture joins the conversation like a message and is used right away.
  const addUploadedImage = (picked) => {
    if (!picked) return;
    setChat((c) => [...c, { id: chatId(), kind: 'upload', file: picked, url: URL.createObjectURL(picked) }]);
    pickImage(picked);
  };

  // Describe a picture: the description and the drawn picture join the conversation, and it is used right away.
  // `given` is a description written by the app (Hook to Reel); from the button it is the click event.
  const generateImage = async (given) => {
    const prompt = (typeof given === 'string' ? given : imagePrompt).trim();
    if (prompt.length < 3 || imageBusy) return;
    const busyId = chatId();
    setChat((c) => [...c, { id: chatId(), kind: 'prompt', text: prompt }, { id: busyId, kind: 'busy' }]);
    if (typeof given !== 'string') setImagePrompt('');
    setImageBusy(true);
    try {
      const res = await fetch(`${API}/images/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, aspect: clip.aspect }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const drawn = new File([await res.blob()], 'ai-image.jpg', { type: 'image/jpeg' });
      setChat((c) => c.map((m) => (m.id === busyId ? { id: busyId, kind: 'image', file: drawn, url: URL.createObjectURL(drawn) } : m)));
      pickImage(drawn);
    } catch (e) {
      setChat((c) => c.map((m) => (m.id === busyId ? { id: busyId, kind: 'error', text: e.message } : m)));
    } finally {
      setImageBusy(false);
    }
  };

  // ---- Hook to Reel: the steps run one after the other, each waiting for the one before ----
  // 1. Once the hooks are known, the window is put on the best one (or the first 30 seconds if none was found)
  // and the user chooses: another hook, or their own part on the timeline. "Make my reel" goes on from there.
  useEffect(() => {
    if (!auto || autoStep !== 'hook' || !duration) return;
    if (hookState === 'ready' || hookState === 'failed') {
      const best = hooks?.[HOOK_KEY]?.[0];
      setHookLen(HOOK_KEY);
      if (best) applyRegion(best.start, best.end);
      else applyRegion(0, Math.min(duration, 30));
      setAutoStep('choose');
    }
  }, [auto, autoStep, hookState, hooks, duration]);

  const chooseHook = (h) => {
    applyRegion(h.start, h.end);
    previewHook(h.start);
  };
  const chooseHookLength = (key) => {
    setHookLen(key);
    const first = hooks?.[key]?.[0];
    if (first) applyRegion(first.start, first.end);
  };

  // 2. Make the lyrics of that window (the window is already in place on this render).
  useEffect(() => {
    if (autoStep !== 'go') return;
    setAutoStep('lyrics');
    handleGenerate();
  }, [autoStep]);

  // 3. With the lyrics ready, draw a picture that fits them. Without a picture the clip still has its gradient.
  useEffect(() => {
    if (autoStep !== 'lyrics') return;
    if (phase === 'error') {
      setAutoStep(null);
      return;
    }
    if (phase !== 'done') return;
    const text = lines.map((l) => l.text.trim()).filter(Boolean);
    if (text.length === 0) {
      setAutoStep(null);
      return;
    }
    setAutoStep('image');
    const prompt = `A cinematic, atmospheric scene that matches the mood of these song lyrics: ${text.slice(0, 6).join(' / ')}`;
    generateImage(prompt.slice(0, 480)).finally(() => {
      setCenterTab('clip');
      setAutoStep('done');
    });
  }, [autoStep, phase, lines]);

  // Keep the newest message in view, close the "Adjust" box when clicking elsewhere, and free the pictures at the end.
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    chatUrlsRef.current = chat.map((m) => m.url).filter(Boolean);
  }, [chat]);
  useEffect(() => () => chatUrlsRef.current.forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    if (!adjustOpen) return;
    const close = (e) => {
      if (adjustRef.current && !adjustRef.current.contains(e.target)) setAdjustOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [adjustOpen]);

  const saveBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // Record the clip in the browser (same drawing code as the preview), then let the server turn the
  // recording into a standard MP4 and save it.
  const exportClip = async () => {
    if (exportState || !clipReady) return;
    const audioBuffer = wsRef.current?.getDecodedData();
    if (!audioBuffer) {
      alert('The audio is still loading. Try again in a moment.');
      return;
    }
    wsRef.current?.pause();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportState({ stage: 'recording', fraction: 0, seconds: 0, total: audioBuffer.duration });
    let lastTick = -1;
    try {
      const { blob } = await recordClip({
        audioBuffer,
        lines: lines.filter((l) => l.text.trim()),
        image: imageElRef.current,
        clip,
        signal: controller.signal,
        onProgress: (fraction, seconds, total) => {
          const tick = Math.floor(seconds * 4); // update the bar four times a second, not every frame
          if (tick === lastTick) return;
          lastTick = tick;
          setExportState({ stage: 'recording', fraction, seconds, total });
        },
      });
      setExportState({ stage: 'converting', fraction: 1, seconds: 0, total: 0 });
      try {
        const body = new FormData();
        body.append('video', blob, 'recording');
        const res = await fetch(`${API}/clips/convert`, { method: 'POST', body });
        if (!res.ok) throw new Error(await errorText(res));
        saveBlob(await res.blob(), 'lyrics_clip.mp4');
      } catch (e) {
        alert(`Could not convert the video to a standard MP4 (${e.message}). Saving the recording as it is.`);
        saveBlob(blob, blob.type.includes('mp4') ? 'lyrics_clip.mp4' : 'lyrics_clip.webm');
      }
    } catch (e) {
      if (e.message === 'hidden') alert('Recording stopped because this tab was hidden. Keep this tab open and in front while the video is being made.');
      else if (e.message !== 'cancelled') alert(`Could not make the video: ${e.message}`);
    } finally {
      exportAbortRef.current = null;
      setExportState(null);
    }
  };

  const cancelExport = () => exportAbortRef.current?.abort();

  // Put an empty line in the gap right after (dir = 1) or before (dir = -1) row i. With no gap it
  // takes a little time from that row instead, so the lines never end up on top of each other.
  const insertNextTo = (i, dir) => {
    const ls = lines.map((l) => ({ ...l }));
    const row = ls[i];
    const WANT = 2;
    const MIN_GAP = 0.6;
    let s0;
    let e0;
    if (dir > 0) {
      const gap = (ls[i + 1]?.start ?? duration) - row.end;
      if (gap >= MIN_GAP) {
        s0 = row.end;
        e0 = s0 + Math.min(WANT, gap);
      } else {
        const room = Math.min(1.2, Math.max(0, row.end - row.start - MIN_LINE));
        row.end -= room;
        s0 = row.end;
        e0 = s0 + Math.max(0.5, Math.min(WANT, gap + room));
      }
    } else {
      const gap = row.start - (ls[i - 1]?.end ?? 0);
      if (gap >= MIN_GAP) {
        e0 = row.start;
        s0 = e0 - Math.min(WANT, gap);
      } else {
        const room = Math.min(1.2, Math.max(0, row.end - row.start - MIN_LINE));
        row.start += room;
        e0 = row.start;
        s0 = Math.max(0, e0 - Math.max(0.5, Math.min(WANT, gap + room)));
      }
    }
    const fresh = { start: Math.max(0, s0), end: Math.min(duration, e0), text: '' };
    ls.splice(dir > 0 ? i + 1 : i, 0, fresh);
    ls.sort((a, b) => a.start - b.start);
    pendingFocus.current = ls.indexOf(fresh);
    setLines(ls);
  };

  // "Add line at 0:14.3": inside a line it goes right after that line, otherwise exactly at the playhead.
  const addLine = () => {
    const t = Math.round(currentTime * 10) / 10;
    const inside = lines.findIndex((l) => t > l.start && t < l.end);
    if (inside >= 0) {
      insertNextTo(inside, 1);
      return;
    }
    const at = lines.findIndex((l) => l.start > t);
    const idx = at === -1 ? lines.length : at;
    const nextStart = lines[idx]?.start ?? duration;
    const end = Math.max(t + 0.5, Math.min(t + 3, nextStart));
    pendingFocus.current = idx;
    setLines([...lines.slice(0, idx), { start: t, end, text: '' }, ...lines.slice(idx)]);
  };

  // Cut the line under the playhead in two, splitting its words in proportion to where you cut.
  const splitIdx = lines.findIndex((l) => currentTime > l.start + 0.2 && currentTime < l.end - 0.2);
  const splitAtPlayhead = () => {
    if (splitIdx < 0) return;
    const l = lines[splitIdx];
    const t = Math.round(currentTime * 10) / 10;
    const words = l.text.trim().split(/\s+/).filter(Boolean);
    const ratio = (t - l.start) / (l.end - l.start);
    const k = words.length > 1 ? clampTo(Math.round(words.length * ratio), 1, words.length - 1) : words.length;
    pendingFocus.current = splitIdx + 1;
    setLines([
      ...lines.slice(0, splitIdx),
      { start: l.start, end: t, text: words.slice(0, k).join(' ') },
      { start: t, end: l.end, text: words.slice(k).join(' ') },
      ...lines.slice(splitIdx + 1),
    ]);
  };

  // While the song plays: "start = now" / "end = now" sets that edge of a line to the playhead.
  const setEdge = (i, edge) => {
    const t = Math.round(currentTime * 10) / 10;
    setLines((ls) => ls.map((l, k) => {
      if (k !== i) return l;
      return edge === 'start'
        ? { ...l, start: clampTo(t, ls[i - 1]?.end ?? 0, l.end - MIN_LINE) }
        : { ...l, end: clampTo(t, l.start + MIN_LINE, ls[i + 1]?.start ?? duration) };
    }));
  };

  // Drag a block on the lyric track to move it, or drag its edges to change when it starts or ends.
  // A block cannot be pushed past its neighbours, so the order of the lines never changes.
  const startDrag = (e, i, mode) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { i, mode, x0: e.clientX, orig: { ...lines[i] }, moved: false };
  };

  const onDrag = (e) => {
    const d = dragRef.current;
    if (!d || !trackRef.current || !duration) return;
    const dx = e.clientX - d.x0;
    if (Math.abs(dx) > 3) d.moved = true;
    const dt = (dx / trackRef.current.getBoundingClientRect().width) * duration;
    const prevEnd = lines[d.i - 1]?.end ?? 0;
    const nextStart = lines[d.i + 1]?.start ?? duration;
    const { start, end } = d.orig;
    let ns = start;
    let ne = end;
    if (d.mode === 'move') {
      ns = clampTo(start + dt, prevEnd, nextStart - (end - start));
      ne = ns + (end - start);
    } else if (d.mode === 'start') {
      ns = clampTo(start + dt, prevEnd, end - MIN_LINE);
    } else {
      ne = clampTo(end + dt, start + MIN_LINE, nextStart);
    }
    setLines((ls) => ls.map((l, k) => (k === d.i ? { ...l, start: ns, end: ne } : l)));
  };

  const endDrag = (e, i) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved && d.mode === 'move') seekTo(lines[i].start); // a plain click plays from there
  };

  const removeLine = (idx) => setLines((ls) => ls.filter((_, i) => i !== idx));

  useEffect(() => {
    if (pendingFocus.current === null) return;
    textRefs.current[pendingFocus.current]?.focus();
    pendingFocus.current = null;
  }, [lines]);

  const updateLineText = (idx, text) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, text } : l)));

  const regionLength = Math.max(0, region.end - region.start);
  const activeStep = stepIndexFor(statusMsg);

  const trimLocked = !file || phase === 'generating';
  const hookList = file && file === originalFile ? hooks?.[hookLen] ?? [] : [];
  const showHookStatus = file && file === originalFile;
  // A clip needs generated lyrics: the audio is then the generated part, which the lines match.
  const clipReady = Boolean(file && originalFile && file !== originalFile && lines.some((l) => l.text.trim()));

  const working = autoStep === 'go' || autoStep === 'lyrics' || autoStep === 'image';
  const wizardView = wizard && (
    <div className="fixed inset-0 z-50 bg-[#0b0b0d] text-zinc-100 font-sans flex flex-col">
      <header className="h-12 shrink-0 border-b border-zinc-800 bg-[#111113] flex items-center gap-3 px-4">
        <button onClick={onBack} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" title="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Sparkles className="w-4 h-4 text-fuchsia-400" />
        <span className="text-sm font-semibold">Hook to Reel</span>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto p-6 flex items-center justify-center">
        <div className="w-full max-w-md">
          {!file || (!autoStep && phase === 'idle') ? (
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); }}
              className="block border-2 border-dashed border-zinc-700 hover:border-fuchsia-500/60 rounded-2xl p-10 text-center cursor-pointer transition-colors"
            >
              <Upload className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <p className="text-zinc-200 font-medium">Drop a song here or click to choose</p>
              <p className="text-sm text-zinc-500 mt-1">MP3 or WAV</p>
              <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
            </label>
          ) : autoStep === 'hook' ? (
            <div className="text-center space-y-2">
              <Loader2 className="w-6 h-6 animate-spin text-fuchsia-400 mx-auto" />
              <p className="text-zinc-200 font-medium">Finding the best part of your song…</p>
              <p className="text-xs text-zinc-500 truncate">{file.name}</p>
            </div>
          ) : autoStep === 'choose' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                <p className="min-w-0 flex-1 text-sm text-zinc-200 truncate" title={file.name}>{file.name}</p>
                <label className="text-xs text-fuchsia-400 hover:text-fuchsia-300 cursor-pointer shrink-0">
                  Replace
                  <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
                </label>
              </div>

              <div>
                <p className="text-sm text-zinc-200 font-medium">Choose the part for your reel</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {(hooks?.[hookLen]?.length ?? 0) > 0
                    ? 'The best part is already selected. Tap another one to hear it and use it.'
                    : 'No hook was found, so the first 30 seconds are used.'}
                </p>
              </div>

              {hookState === 'ready' && Object.keys(hooks ?? {}).length > 1 && (
                <div className="flex gap-1.5">
                  {Object.keys(hooks).map((key) => (
                    <button
                      key={key} onClick={() => chooseHookLength(key)}
                      className={`px-3 py-1 rounded-md text-xs border transition-colors ${
                        hookLen === key ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-300' : 'border-zinc-800 text-zinc-400 hover:border-zinc-700'
                      }`}
                    >
                      {key} sec
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                {(hooks?.[hookLen] ?? []).slice(0, 4).map((h, i) => {
                  const selected = Math.abs(region.start - h.start) < 0.05 && Math.abs(region.end - h.end) < 0.05;
                  return (
                    <button
                      key={i} onClick={() => chooseHook(h)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${
                        selected ? 'border-fuchsia-500 bg-fuchsia-500/10' : 'border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      <Play className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      <span className="text-sm text-zinc-200">Hook {i + 1}</span>
                      {i === 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">Best</span>}
                      <span className="ml-auto font-mono text-xs text-zinc-400">{formatTime(h.start)} – {formatTime(h.end)}</span>
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => setAutoStep('go')}
                className="w-full py-3 rounded-xl text-sm font-medium bg-fuchsia-600 hover:bg-fuchsia-500 transition-colors flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" /> Create reel <span className="font-mono text-fuchsia-200">({formatTime(regionLength)})</span>
              </button>
            </div>
          ) : working ? (
            <div className="space-y-3 mx-auto w-fit">
              {[
                { label: 'Writing the lyrics', done: autoStep === 'image', active: autoStep !== 'image' },
                { label: 'Drawing the picture', done: false, active: autoStep === 'image' },
              ].map((s) => (
                <div key={s.label} className={`flex items-center gap-3 text-sm ${s.done ? 'text-emerald-400' : s.active ? 'text-zinc-100' : 'text-zinc-600'}`}>
                  {s.done ? <Check className="w-4 h-4" /> : s.active ? <Loader2 className="w-4 h-4 animate-spin text-fuchsia-400" /> : <span className="w-4 h-4 rounded-full border border-zinc-700" />}
                  {s.label}
                </div>
              ))}
              {statusMsg && autoStep !== 'image' && <p className="text-xs text-zinc-500 pl-7">{statusMsg}</p>}
            </div>
          ) : phase === 'error' ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-rose-300 break-words">Something went wrong: {error}</p>
              <button onClick={() => setAutoStep('go')} className="px-4 py-2 rounded-md text-sm border border-zinc-700 hover:bg-zinc-800 transition-colors inline-flex items-center gap-2">
                <RotateCcw className="w-4 h-4" /> Try again
              </button>
            </div>
          ) : (
            <div className="text-center space-y-3">
              <p className="text-sm text-zinc-400">No lyrics were detected in this part. Try another part of the song.</p>
              <button onClick={backToFullSong} className="px-4 py-2 rounded-md text-sm border border-zinc-700 hover:bg-zinc-800 transition-colors">
                Choose another part
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );

  return (
    <div className="h-[100dvh] w-full bg-[#0b0b0d] text-zinc-100 font-sans flex flex-col overflow-hidden">
      {wizardView}
      {/* Top bar */}
      <header className="h-12 shrink-0 border-b border-zinc-800 bg-[#111113] flex items-center gap-3 px-3">
        <button onClick={onBack} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" title="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2">
          {auto ? <Sparkles className="w-4 h-4 text-fuchsia-400" /> : <Languages className="w-4 h-4 text-indigo-400" />}
          <span className="text-sm font-semibold">{auto ? 'Hook to Reel' : 'Lyrics Studio'}</span>
        </div>
        <span className="text-zinc-700">/</span>
        <span className="text-sm text-zinc-400 truncate max-w-md">{file ? file.name : 'No song loaded'}</span>
        <div className="ml-auto flex items-center gap-3">
          {phase === 'generating' && (
            <span className="text-xs text-indigo-300 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Working…</span>
          )}
          {separating && (
            <span className="text-xs text-indigo-300 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Removing voice…</span>
          )}
          {auto && autoStep === 'done' && <span className="text-xs text-emerald-400">Reel ready. Press Download MP4.</span>}
          {phase === 'done' && !(auto && autoStep) && <span className="text-xs text-emerald-400">Transcript ready</span>}
          {exportState ? (
            <div className="flex items-center gap-2 text-xs text-indigo-300">
              <div className="w-28 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${Math.round(exportState.fraction * 100)}%` }} />
              </div>
              <span>
                {exportState.stage === 'recording'
                  ? `${Math.floor(exportState.seconds)}s / ${Math.ceil(exportState.total)}s · keep this tab open`
                  : 'Finishing the MP4…'}
              </span>
              {exportState.stage === 'recording' && (
                <button onClick={cancelExport} className="text-zinc-400 hover:text-rose-400">Cancel</button>
              )}
            </div>
          ) : (
            <button
              onClick={exportClip} disabled={!clipReady || !canRecord()}
              title={
                !canRecord() ? 'This browser cannot record video. Please use Chrome or Edge.'
                  : clipReady ? 'The video is made in this browser, so it takes as long as the clip. Keep this tab open while it records.'
                    : 'Generate the lyrics first'
              }
              className="px-4 py-1.5 rounded-md text-sm font-medium bg-white text-zinc-900 hover:bg-zinc-200 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Download MP4
            </button>
          )}
        </div>
      </header>

      {/* How the clip looks: one flat line */}
      <div className="h-11 shrink-0 border-b border-zinc-800 bg-[#0d0d0f] px-3 flex items-center gap-2">
        <Film className="w-4 h-4 text-zinc-500 mr-1 shrink-0" />
        <Dropdown compact label="Size" value={clip.aspect} options={SIZE_OPTIONS} onChange={(v) => setClipOpt({ aspect: v })} />
        <Dropdown compact label="Font" value={clip.font} options={FONT_OPTIONS} onChange={(v) => setClipOpt({ font: v })} />
        <Dropdown compact label="Animation" value={clip.animation} options={ANIMATION_OPTIONS} onChange={(v) => setClipOpt({ animation: v })} />
        <Dropdown compact label="Style" value={clip.style} options={STYLE_OPTIONS} onChange={(v) => setClipOpt({ style: v })} />
        <div ref={adjustRef} className="relative">
          <button
            onClick={() => setAdjustOpen((o) => !o)}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200 hover:border-zinc-700 transition-colors"
          >
            Adjust <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          </button>
          {adjustOpen && (
            <div className="absolute z-30 left-0 mt-1 w-72 rounded-md border border-zinc-700 bg-[#18181b] shadow-xl p-3 space-y-3">
              <Slider label="Text size" value={clip.fontScale} min={0.6} max={1.6} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setClipOpt({ fontScale: v })} />
              <Slider label="Outline" value={clip.outline} min={0} max={12} step={1} onChange={(v) => setClipOpt({ outline: v })} />
              <Slider label="Picture darkness" value={clip.dim} min={0} max={0.8} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setClipOpt({ dim: v })} />
              <Slider label="Animation speed" value={clip.animSpeed} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}x`} onChange={(v) => setClipOpt({ animSpeed: v })} />
              <div className="grid grid-cols-2 gap-3">
                <label className="text-[10px] text-zinc-500">
                  Text colour
                  <input type="color" value={clip.textColor} onChange={(e) => setClipOpt({ textColor: e.target.value })} className="block w-full h-8 mt-1 bg-transparent rounded cursor-pointer" />
                </label>
                <label className="text-[10px] text-zinc-500">
                  Highlight colour
                  <input type="color" value={clip.highlightColor} onChange={(e) => setClipOpt({ highlightColor: e.target.value })} className="block w-full h-8 mt-1 bg-transparent rounded cursor-pointer" />
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
                <input type="checkbox" checked={clip.shadow} onChange={(e) => setClipOpt({ shadow: e.target.checked })} className="accent-indigo-500" />
                Shadow
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-y-auto lg:overflow-y-hidden">
        {/* Left: the picture, as a conversation */}
        <aside style={{ width: panelW.left }} className="shrink-0 border-b lg:border-b-0 lg:border-r border-zinc-800 bg-[#0f0f11] flex flex-col min-h-[400px] lg:min-h-0 !w-full lg:!w-auto">
          <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold">Picture</span>
            <span className="text-xs text-zinc-500">for your clip</span>
          </div>

          {/* The conversation: uploads, descriptions and the pictures that were drawn */}
          <div ref={chatRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
            <div className="max-w-[92%] rounded-2xl rounded-tl-sm bg-zinc-800/70 px-3 py-2 text-xs leading-relaxed text-zinc-300">
              Use your own picture for the video, or describe one and I will draw it. The lyrics are put on top of it.
            </div>
            {chat.map((m) => {
              const selected = m.file && m.file === imageFile;
              if (m.kind === 'prompt') {
                return (
                  <div key={m.id} className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-indigo-600 px-3 py-2 text-xs leading-relaxed text-white break-words">
                    {m.text}
                  </div>
                );
              }
              if (m.kind === 'busy') {
                return (
                  <div key={m.id} className="max-w-[92%] rounded-2xl rounded-tl-sm bg-zinc-800/70 px-3 py-2 text-xs text-zinc-300 flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-300" /> Drawing your picture…
                  </div>
                );
              }
              if (m.kind === 'error') {
                return (
                  <div key={m.id} className="max-w-[92%] rounded-2xl rounded-tl-sm bg-rose-950/60 border border-rose-900 px-3 py-2 text-xs leading-relaxed text-rose-200 break-words">
                    Could not draw it: {m.text}
                  </div>
                );
              }
              return (
                <div key={m.id} className={m.kind === 'upload' ? 'ml-auto max-w-[85%]' : 'max-w-[92%]'}>
                  <button
                    onClick={() => pickImage(m.file)}
                    className={`block rounded-xl overflow-hidden border-2 transition-colors ${selected ? 'border-indigo-400' : 'border-transparent hover:border-zinc-600'}`}
                    title="Use this picture"
                  >
                    <img src={m.url} alt="" className="w-full max-h-56 object-cover" />
                  </button>
                  <p className={`mt-1 text-[11px] ${m.kind === 'upload' ? 'text-right' : ''} ${selected ? 'text-indigo-300' : 'text-zinc-500'}`}>
                    {selected ? 'Used for the clip' : 'Click to use this picture'}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Two ways to get the picture, both always there: your own image, or one drawn by AI */}
          <div className="shrink-0 p-3 space-y-2">
            <label className="w-full py-2 rounded-xl border border-dashed border-zinc-600 hover:border-indigo-400 text-sm text-zinc-300 flex items-center justify-center gap-2 cursor-pointer transition-colors">
              <ImageIcon className="w-4 h-4 text-zinc-400" /> Use my own image
              <input
                type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => {
                  addUploadedImage(e.target.files[0]);
                  e.target.value = '';
                }}
              />
            </label>

            <div className="flex items-center gap-2 text-[11px] text-zinc-600">
              <span className="flex-1 h-px bg-zinc-800" /> or let AI draw one <span className="flex-1 h-px bg-zinc-800" />
            </div>

            <div className="rounded-2xl border border-zinc-700 bg-zinc-900/80 p-2 focus-within:border-indigo-500 transition-colors">
              {imageFile && (
                <div className="flex items-center gap-2 px-1 pb-1.5 text-[11px] text-zinc-400">
                  <img src={imagePreview} alt="" className="w-6 h-6 rounded object-cover" />
                  <span className="flex-1 truncate">Picture in use</span>
                  <button onClick={() => setImageFile(null)} className="hover:text-rose-400" title="Use the plain gradient instead">Remove</button>
                </div>
              )}
              <textarea
                rows={2} maxLength={500} value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    generateImage();
                  }
                }}
                placeholder="Describe the picture, e.g. a calm rainy city at night with purple lights"
                className="w-full resize-none bg-transparent px-1 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none"
              />
              <div className="flex justify-end mt-1">
                <button
                  onClick={generateImage} disabled={imageBusy || imagePrompt.trim().length < 3}
                  className="w-8 h-8 rounded-full flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors"
                  title="Draw it with AI (the cheapest image model of your OpenAI key)"
                >
                  {imageBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </aside>
        <div className="hidden lg:block"><PanelResizer onStart={startResize('left')} onMove={moveResize} onEnd={endResize} onReset={resetPanel('left')} /></div>

        {/* Center: preview + timeline */}
        <main className="flex-1 min-w-0 flex flex-col">
          <div className={`relative flex-1 min-h-[160px] flex items-center justify-center bg-gradient-to-b from-[#101014] to-[#0b0b0d] ${lines.length > 0 && phase !== 'generating' && phase !== 'error' ? '' : 'p-8'}`}>
            {file && lines.length > 0 && phase !== 'generating' && (
              <div className="absolute top-3 right-4 z-20 flex rounded-md border border-zinc-700 overflow-hidden text-xs bg-zinc-900/80 backdrop-blur">
                {[{ id: 'lyrics', label: 'Lyrics' }, { id: 'clip', label: 'Clip preview' }].map((tab) => (
                  <button
                    key={tab.id} onClick={() => setCenterTab(tab.id)}
                    className={`px-3 py-1.5 transition-colors ${centerTab === tab.id ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white'}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
            {!file ? (
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); }}
                className="w-full max-w-xl border-2 border-dashed border-zinc-700 hover:border-indigo-500/60 rounded-2xl p-8 text-center cursor-pointer transition-colors"
              >
                <Upload className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
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
            ) : lines.length > 0 && centerTab === 'clip' ? (
              <div
                ref={clipBoxRef}
                className={`w-full h-full flex flex-col items-center gap-2 ${isFullscreen ? 'bg-black p-0 gap-0' : 'p-4'}`}
              >
                <canvas
                  ref={previewCanvasRef}
                  width={SIZES[clip.aspect][0] / 2} height={SIZES[clip.aspect][1] / 2}
                  className={`flex-1 min-h-0 w-full bg-black touch-none ${isFullscreen ? '' : 'rounded-lg cursor-move'}`}
                  style={{ objectFit: 'contain' }}
                  onPointerDown={isFullscreen ? undefined : startTextDrag}
                  onPointerMove={isFullscreen ? undefined : moveText}
                  onPointerUp={isFullscreen ? undefined : endTextDrag}
                  onDoubleClick={isFullscreen ? undefined : resetTextPosition}
                />
                {isFullscreen ? (
                  <div className="w-full shrink-0 h-12 bg-black/80 flex items-center gap-4 px-4">
                    <button
                      onClick={togglePlay}
                      className="w-8 h-8 rounded-full bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center transition-colors"
                      title="Play / pause (Space)"
                    >
                      {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                    </button>
                    <span className="font-mono text-xs text-zinc-300">{formatTime(currentTime)}</span>
                    <span className="font-mono text-xs text-zinc-600">/ {formatTime(duration)}</span>
                    <button
                      onClick={toggleFullscreen}
                      className="ml-auto px-3 py-1.5 rounded-md text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-1.5 transition-colors"
                      title="Leave full screen (Esc)"
                    >
                      <Minimize className="w-3.5 h-3.5" /> Exit full screen
                    </button>
                  </div>
                ) : (
                  <div className="w-full flex items-center gap-3">
                    <p className="flex-1 text-[11px] text-zinc-500">Drag the text to place it (double-click puts it back). Press play (or Space) to watch it with the song. The video you download looks exactly like this.</p>
                    <button
                      onClick={toggleFullscreen}
                      className="shrink-0 px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-200 hover:bg-zinc-800 flex items-center gap-1.5 transition-colors"
                      title="Watch the clip full screen"
                    >
                      <Maximize className="w-3.5 h-3.5" /> Full screen
                    </button>
                  </div>
                )}
              </div>
            ) : lines.length > 0 ? (
              <div ref={previewRef} className="relative w-full h-full overflow-y-auto text-center">
                <div className="max-w-3xl mx-auto py-[30vh] px-4 space-y-5">
                  {lines.map((l, i) => {
                    const isActive = i === activeIdx;
                    return (
                      <p
                        key={i}
                        ref={(el) => { previewRowRefs.current[i] = el; }}
                        onClick={() => seekTo(l.start)}
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
          <div className="shrink-0 border-t border-zinc-800 bg-[#0f0f11] px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <PanelTitle>Timeline</PanelTitle>
                {originalFile && file !== originalFile && (
                  <button
                    onClick={backToFullSong}
                    className="-mt-3 px-3 py-1 rounded-md text-xs border border-zinc-700 text-zinc-200 hover:bg-zinc-800 flex items-center gap-1.5 transition-colors"
                    title="Go back to the full song and change the trimmed part"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" /> Back to trim
                  </button>
                )}
              </div>
              <span className="text-[11px] text-zinc-500 -mt-3 flex items-center gap-1.5">
                {showHookStatus && hookState === 'finding' && (<><Loader2 className="w-3 h-3 animate-spin" /> Finding hooks…</>)}
                {showHookStatus && hookState === 'ready' && hookList.length > 0 && 'White dots are the hooks. Click one to listen, then trim around it.'}
                {showHookStatus && hookState === 'failed' && 'Could not find the hooks.'}
              </span>
            </div>

            {/* Hook rail: a dot wherever the song's hook is */}
            <div className="relative h-5">
              <div className="absolute inset-x-0 top-1/2 h-px bg-zinc-700" />
              {duration > 0 && hookList.map((h, i) => (
                <button
                  key={i}
                  onClick={() => previewHook(h.start)}
                  title={`${i === 0 ? 'Best hook' : 'Hook'} at ${formatTime(h.start)}. Click to listen.`}
                  style={{ left: `${(h.start / duration) * 100}%` }}
                  className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-4 ring-[#0f0f11] hover:scale-125 transition-transform ${i === 0 ? 'w-4.5 h-4.5' : 'w-3 h-3 opacity-80'}`}
                />
              ))}
            </div>

            <div className="relative pt-5">
              <div ref={waveformRef} className={file ? '' : 'opacity-0 h-[60px]'} />
              {!file && (
                <div className="absolute inset-x-0 top-5 h-[60px] border border-dashed border-zinc-800 rounded-md flex items-center justify-center text-xs text-zinc-600">
                  The waveform appears here
                </div>
              )}
              {/* Dim everything outside the window and show how long the selection is */}
              {file && duration > 0 && (
                <>
                  <div className="absolute top-5 bottom-0 left-0 z-10 bg-black/60 pointer-events-none" style={{ width: `${(region.start / duration) * 100}%` }} />
                  <div className="absolute top-5 bottom-0 right-0 z-10 bg-black/60 pointer-events-none" style={{ width: `${(1 - region.end / duration) * 100}%` }} />
                  <div
                    className="absolute top-0 z-10 -translate-x-1/2 text-[11px] font-mono text-zinc-400 whitespace-nowrap pointer-events-none"
                    style={{ left: `${Math.min(92, Math.max(8, ((region.start + region.end) / 2 / duration) * 100))}%` }}
                  >
                    {(region.end - region.start).toFixed(1)}s
                  </div>
                </>
              )}
            </div>
            {/* Lyric track, aligned to the waveform above */}
            <div ref={trackRef} className="relative h-8 mt-2 bg-zinc-900/60 border border-zinc-800 rounded-md overflow-hidden">
              {duration > 0 && lines.map((l, i) => (
                <div
                  key={i}
                  title={`${l.text}\nDrag to move, drag the edges to change the timing`}
                  style={{
                    left: `${(l.start / duration) * 100}%`,
                    width: `${Math.max(((l.end - l.start) / duration) * 100, 0.4)}%`,
                  }}
                  className={`absolute top-1 bottom-1 rounded flex text-[10px] leading-6 select-none touch-none ${
                    i === activeIdx ? 'bg-amber-400/90 text-zinc-900' : 'bg-indigo-500/40 text-indigo-100 hover:bg-indigo-500/60'
                  }`}
                >
                  <span
                    className="w-1.5 shrink-0 cursor-ew-resize rounded-l bg-white/30"
                    onPointerDown={(e) => startDrag(e, i, 'start')} onPointerMove={onDrag} onPointerUp={(e) => endDrag(e, i)}
                  />
                  <span
                    className="flex-1 min-w-0 truncate px-1 cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => startDrag(e, i, 'move')} onPointerMove={onDrag} onPointerUp={(e) => endDrag(e, i)}
                  >
                    {l.text}
                  </span>
                  <span
                    className="w-1.5 shrink-0 cursor-ew-resize rounded-r bg-white/30"
                    onPointerDown={(e) => startDrag(e, i, 'end')} onPointerMove={onDrag} onPointerUp={(e) => endDrag(e, i)}
                  />
                </div>
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
        <div className="hidden lg:block"><PanelResizer onStart={startResize('right')} onMove={moveResize} onEnd={endResize} onReset={resetPanel('right')} /></div>
        <aside style={{ width: panelW.right }} className="shrink-0 border-t lg:border-t-0 lg:border-l border-zinc-800 bg-[#0f0f11] flex flex-col min-h-[400px] lg:min-h-0 !w-full lg:!w-auto">
          {!file ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <p className="text-sm text-zinc-600 text-center">Choose a song to begin. Then pick the part you want and generate the lyrics.</p>
            </div>
          ) : (
            <>
              {/* Song, trim and voice, above the transcript */}
              <div className="shrink-0 p-4 border-b border-zinc-800 space-y-4">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate" title={file.name}>{file.name}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500 flex items-center gap-2 flex-wrap">
                    <span>{(file.size / 1024 / 1024).toFixed(1)} MB{duration ? ` · ${formatTime(duration)}` : ''}</span>
                    <label className="text-indigo-400 hover:text-indigo-300 cursor-pointer">
                      Replace
                      <input type="file" accept="audio/*" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
                    </label>
                    {originalFile && file !== originalFile && (
                      <button
                        onClick={backToFullSong}
                        className="text-amber-300 hover:text-amber-200"
                        title="Go back to the full song and pick a different part"
                      >
                        Choose another part
                      </button>
                    )}
                  </p>
                </div>

                <div>
                  <PanelTitle>Part to use</PanelTitle>
                  <div className="grid grid-cols-3 gap-2">
                    <TimeField label="Start" value={region.start} disabled={trimLocked} onCommit={(v) => applyRegion(v, region.end)} />
                    <TimeField label="End" value={region.end} disabled={trimLocked} onCommit={(v) => applyRegion(region.start, v)} />
                    <div
                      className="min-w-0"
                      title={`Drag the edges on the timeline. Up to ${ISOLATE_MAX_SEC}s the vocals are separated first, which gives better lyrics but takes about a minute.`}
                    >
                      <span className="block text-[10px] text-zinc-500 mb-1">Length</span>
                      <p className="border border-transparent px-2 py-1.5 text-xs font-mono text-zinc-300">{formatTime(regionLength)}</p>
                    </div>
                  </div>
                </div>

                <label
                  className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300"
                  title="The lyrics stay on screen, but only the music plays. The voice is taken out after the lyrics are ready, and that takes about as long as the part itself."
                >
                  <input
                    type="checkbox" checked={removeVoice} disabled={phase === 'generating' || separating}
                    onChange={(e) => changeRemoveVoice(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  Remove voice (karaoke)
                  {separating && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-300" />}
                </label>

                <button
                  onClick={handleGenerate}
                  disabled={phase === 'generating'}
                  className="w-full py-2 rounded-md text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors flex items-center justify-center gap-2"
                >
                  {phase === 'generating' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {phase === 'generating' ? 'Working…' : phase === 'done' ? 'Regenerate lyrics' : 'Generate lyrics'}
                </button>
              </div>

              <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Lyrics</h2>
                <span className="text-xs text-zinc-600">{lines.length}</span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={addLine} disabled={phase === 'generating'}
                    className="px-2 py-1 rounded-md text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex items-center gap-1"
                    title="Add an empty line at the playhead (or after the line the playhead is in)"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add
                  </button>
                  <button
                    onClick={splitAtPlayhead} disabled={splitIdx < 0 || phase === 'generating'}
                    className="px-2 py-1 rounded-md text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent transition-colors flex items-center gap-1"
                    title="Cut the line under the playhead into two"
                  >
                    <Scissors className="w-3.5 h-3.5" /> Split
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-2">
                {lines.length === 0 ? (
                  <p className="text-sm text-zinc-600 p-4">
                    {phase === 'generating' ? 'Working on it…' : 'Press “Generate lyrics”. You can then fix any word by clicking on it.'}
                  </p>
                ) : (
                  lines.map((l, i) => (
                    <div
                      key={i}
                      ref={(el) => { rowRefs.current[i] = el; }}
                      className={`group rounded-lg px-2 py-1.5 transition-colors ${i === activeIdx ? 'bg-amber-400/10' : 'hover:bg-zinc-900/60'}`}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => seekTo(l.start)}
                          className={`shrink-0 mt-1.5 font-mono text-[11px] hover:text-white ${i === activeIdx ? 'text-amber-300' : 'text-zinc-500'}`}
                          title="Play from here"
                        >
                          {formatTime(l.start)}
                        </button>
                        <textarea
                          ref={(el) => { textRefs.current[i] = el; }}
                          rows={2}
                          maxLength={200}
                          value={l.text}
                          onChange={(e) => updateLineText(i, e.target.value)}
                          className={`flex-1 min-w-0 resize-none bg-transparent text-sm leading-snug rounded px-1.5 py-1 focus:outline-none focus:bg-zinc-900 ${i === activeIdx ? 'text-amber-200' : 'text-zinc-200'}`}
                        />
                        <button
                          onClick={() => removeLine(i)}
                          className="shrink-0 mt-1 p-1 rounded text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-rose-400 transition"
                          title="Delete this line"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="mt-0.5 pl-[3.4rem] flex gap-3 text-[10px] text-zinc-500 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button onClick={() => setEdge(i, 'start')} className="hover:text-indigo-300" title="Make this line start at the playhead">start = now</button>
                        <button onClick={() => setEdge(i, 'end')} className="hover:text-indigo-300" title="Make this line end at the playhead">end = now</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
