import { useState, useEffect, useMemo, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { Upload, Music, Download, Loader2, SlidersHorizontal, Play, Pause, Mic, MicOff, Wand2, ArrowLeft, Clock, PlayCircle, Film, Image as ImageIcon, Plus, X, Languages, Headphones, AudioLines, Sparkles, Drama, Pencil, Trash2, Check } from 'lucide-react';
import LyricsEditor from './LyricsEditor';
import RemixStudio from './RemixStudio';
import AudioExtractor from './AudioExtractor';
import VoiceChanger from './VoiceChanger';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const LANGUAGES = [
  { id: 'hi', name: 'Hindi' },
  { id: 'en', name: 'English' },
  { id: 'auto', name: 'Auto-detect' },
];

const INSTRUMENTS = [
  { id: 'sitar', name: 'Sitar' },
  { id: 'guitar', name: 'Guitar' },
  { id: 'flute', name: 'Flute' },
  { id: 'piano', name: 'Piano' },
  { id: 'violin', name: 'Violin' },
  { id: 'santoor', name: 'Santoor' },
];

const formatTime = (timeInSeconds) => {
  if (!timeInSeconds) return '0.0s';
  const m = Math.floor(timeInSeconds / 60);
  const s = (timeInSeconds % 60).toFixed(1);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

// Map backend status strings to a realistic baseline progress percentage
const getBaseProgress = (statusMsg) => {
  if (!statusMsg) return 0;
  const s = statusMsg.toLowerCase();
  if (s.includes('queued')) return 5;
  if (s.includes('uploading')) return 10;
  if (s.includes('starting pipeline')) return 15;
  if (s.includes('trimming')) return 20;
  if (s.includes('separating vocals')) return 30; // starts at 30, naturally climbs to 85
  if (s.includes('extracting melody')) return 50;
  if (s.includes('finding lyrics')) return 65;
  if (s.includes('rendering video')) return 85;
  if (s.includes('ai is composing')) return 70;
  if (s.includes('finalizing')) return 85;
  if (s.includes('playing')) return 88;
  if (s.includes('uploading to cloud')) return 90; // climbs to 99
  if (s.includes('done')) return 100;
  return 50;
};

export default function App() {
  const [mode, setMode] = useState(null); // 'remove_voice', 'compose', 'reel' or 'view_history'
  const [file, setFile] = useState(null);

  // Reel mode state
  const [bgImage, setBgImage] = useState(null);
  const [language, setLanguage] = useState('hi');
  const [lyricLines, setLyricLines] = useState([]);
  const [reelVersion, setReelVersion] = useState(0);
  const [isRerendering, setIsRerendering] = useState(false);

  const [instrument, setInstrument] = useState('sitar');
  const [settings, setSettings] = useState({
    note_smoothing: false,
    pitch_bend: false,
    tempo: 1.0,
    melodyVolume: 100
  });
  
  // History State
  const [history, setHistory] = useState([]);
  const [activeHistoryItem, setActiveHistoryItem] = useState(null);
  const [editingHistoryId, setEditingHistoryId] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [deletingHistoryId, setDeletingHistoryId] = useState(null);

  const [isGenerating, setIsGenerating] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);

  // Live tweaks on a finished compose job: the extracted melody stays on the server, so
  // changing instrument/transpose/accompaniment afterwards only re-renders, not the whole pipeline.
  const [instrumentsList, setInstrumentsList] = useState(INSTRUMENTS); // replaced by /instruments once loaded
  const [project, setProject] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState('');
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiReply, setAiReply] = useState('');
  const editDebounce = useRef(null);

  // Natural Progress State
  const [displayProgress, setDisplayProgress] = useState(0);

  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [totalDuration, setTotalDuration] = useState(0);
  const waveformRef = useRef(null);
  const wavesurfer = useRef(null);
  const regions = useRef(null);
  const [region, setRegion] = useState({ start: 0, end: 0 });

  // Live pitch/tempo tweak on a finished Remove Voice / Extract Vocals job: the separated part
  // stays on the server, so this just re-renders the effect instead of redoing separation.
  const [karaokePitch, setKaraokePitch] = useState(0);
  const [karaokeTempo, setKaraokeTempo] = useState(1.0);
  const [karaokeBlobUrl, setKaraokeBlobUrl] = useState(null);
  const [karaokeTweaking, setKaraokeTweaking] = useState(false);
  const [karaokeTweakError, setKaraokeTweakError] = useState('');
  const karaokeTweakSeq = useRef(0);
  useEffect(() => () => { if (karaokeBlobUrl) URL.revokeObjectURL(karaokeBlobUrl); }, [karaokeBlobUrl]);

  // Fetch history from backend
  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API}/history`);
      if (res.ok) {
        const data = await res.json();
        setHistory(data);
      }
    } catch (err) {
      console.error("Failed to fetch history:", err);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [mode]);

  const startRenameHistoryItem = (item) => {
    setEditingHistoryId(item.job_id);
    setEditingValue(item.filename);
  };

  const cancelRenameHistoryItem = () => {
    setEditingHistoryId(null);
    setEditingValue('');
  };

  const saveRenameHistoryItem = async (jobId) => {
    const filename = editingValue.trim();
    if (!filename) return;
    try {
      const res = await fetch(`${API}/history/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) throw new Error('Could not rename this item');
      setHistory((items) => items.map((it) => (it.job_id === jobId ? { ...it, filename } : it)));
      setEditingHistoryId(null);
      setEditingValue('');
    } catch (err) {
      alert(err.message);
    }
  };

  const deleteHistoryItem = async (item) => {
    if (!window.confirm(`Delete "${item.filename}" from history? This cannot be undone.`)) return;
    setDeletingHistoryId(item.job_id);
    try {
      const res = await fetch(`${API}/history/${item.job_id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not delete this item');
      setHistory((items) => items.filter((it) => it.job_id !== item.job_id));
    } catch (err) {
      alert(err.message);
    } finally {
      setDeletingHistoryId(null);
    }
  };

  // The full instrument list (18) lives on the backend; the constant above is just a fallback.
  useEffect(() => {
    fetch(`${API}/instruments`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setInstrumentsList(data); })
      .catch((err) => console.error("Failed to fetch instruments:", err));
  }, []);

  const fetchProject = async (id) => {
    try {
      const res = await fetch(`${API}/projects/${id}`);
      if (res.ok) setProject(await res.json());
    } catch (err) {
      console.error("Failed to fetch project:", err);
    }
  };

  // Apply a settings change to a finished job: it re-renders from the cached melody, so it's quick.
  const applyEdit = async (ops) => {
    if (!jobId) return;
    setEditing(true);
    setEditError('');
    try {
      const res = await fetch(`${API}/projects/${jobId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ops),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not update the tune');
      }
      setProject(await res.json());
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditing(false);
    }
  };

  // For sliders: wait for the drag to settle before hitting the server.
  const applyEditDebounced = (ops, delay = 400) => {
    if (editDebounce.current) clearTimeout(editDebounce.current);
    editDebounce.current = setTimeout(() => applyEdit(ops), delay);
  };

  const applyAiEdit = async () => {
    if (!jobId || !aiInstruction.trim()) return;
    setEditing(true);
    setEditError('');
    setAiReply('');
    try {
      const res = await fetch(`${API}/projects/${jobId}/ai-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: aiInstruction.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not apply that');
      }
      const data = await res.json();
      setProject(data.project);
      setAiReply(data.reply);
      setAiInstruction('');
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditing(false);
    }
  };

  // Re-render the separated karaoke part at a new pitch/tempo (mode is 'remove_voice' or 'vocals_only').
  // `overrides` carries a just-changed value in, since the state setter that triggered this
  // hasn't landed yet when this runs.
  const applyKaraokeTweak = async (overrides = {}) => {
    if (!jobId) return;
    const seq = ++karaokeTweakSeq.current;
    setKaraokeTweaking(true);
    setKaraokeTweakError('');
    try {
      const res = await fetch(`${API}/tunes/${jobId}/tweak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, pitch: karaokePitch, tempo: karaokeTempo, ...overrides }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not update');
      }
      const blob = await res.blob();
      if (seq !== karaokeTweakSeq.current) return; // a newer tweak is already in flight
      setKaraokeBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } catch (err) {
      if (seq === karaokeTweakSeq.current) setKaraokeTweakError(err.message);
    } finally {
      if (seq === karaokeTweakSeq.current) setKaraokeTweaking(false);
    }
  };
  const karaokeDebounce = useRef(null);
  const applyKaraokeTweakDebounced = (overrides, delay = 400) => {
    if (karaokeDebounce.current) clearTimeout(karaokeDebounce.current);
    karaokeDebounce.current = setTimeout(() => applyKaraokeTweak(overrides), delay);
  };

  // Natural Progress Animation Effect
  useEffect(() => {
    if (!isGenerating) {
      if (resultUrl) setDisplayProgress(100);
      else setDisplayProgress(0);
      return;
    }

    const baseProgress = getBaseProgress(jobStatus);
    if (displayProgress < baseProgress) {
      setDisplayProgress(baseProgress);
    }

    let interval;
    if (jobStatus) {
      const s = jobStatus.toLowerCase();
      // If we are in the slow AI phase, naturally increment progress
      if (s.includes('separating vocals')) {
        interval = setInterval(() => {
          setDisplayProgress((prev) => (prev < 85 ? prev + 1 : prev));
        }, 1500); // +1% every 1.5 seconds
      } else if (s.includes('uploading to cloud')) {
        interval = setInterval(() => {
          setDisplayProgress((prev) => (prev < 98 ? prev + 1 : prev));
        }, 300); // +1% every 0.3s
      }
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [jobStatus, isGenerating, displayProgress, resultUrl]);


  useEffect(() => {
    if (file && waveformRef.current && !wavesurfer.current && (mode === 'remove_voice' || mode === 'vocals_only' || mode === 'compose' || mode === 'reel')) {
      wavesurfer.current = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: '#4f46e5',
        progressColor: '#818cf8',
        cursorColor: '#c7d2fe',
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        height: 60,
        backgroundColor: 'transparent'
      });

      regions.current = wavesurfer.current.registerPlugin(RegionsPlugin.create());

      wavesurfer.current.on('ready', () => {
        const duration = wavesurfer.current.getDuration();
        setTotalDuration(duration);
        
        regions.current.addRegion({
          start: 0,
          end: duration,
          color: 'rgba(0, 0, 0, 0.6)',
          drag: true,
          resize: true,
        });
        setRegion({ start: 0, end: duration });
      });

      regions.current.on('region-updated', (r) => {
        setRegion({ start: r.start, end: r.end });
      });

      const url = URL.createObjectURL(file);
      wavesurfer.current.load(url);
    }
    
    return () => {
      if (wavesurfer.current && (!file || mode === 'view_history' || mode === null)) {
        wavesurfer.current.destroy();
        wavesurfer.current = null;
      }
    };
  }, [file, mode]);

  const bgPreview = useMemo(() => (bgImage ? URL.createObjectURL(bgImage) : null), [bgImage]);
  useEffect(() => () => {
    if (bgPreview) URL.revokeObjectURL(bgPreview);
  }, [bgPreview]);

  const fetchReelLyrics = async (id) => {
    try {
      const res = await fetch(`${API}/reels/${id}/lyrics`);
      if (res.ok) setLyricLines(await res.json());
    } catch (err) {
      console.error("Failed to fetch lyrics:", err);
    }
  };

  const updateLine = (idx, patch) => {
    setLyricLines((lines) => lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    setLyricLines((lines) => {
      const start = lines.length ? lines[lines.length - 1].end + 0.2 : 0;
      return [...lines, { start, end: start + 3, text: '' }];
    });
  };

  const handleRerender = async () => {
    setIsRerendering(true);
    try {
      const res = await fetch(`${API}/reels/${jobId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: lyricLines.filter((l) => l.text.trim()) }),
      });
      if (res.ok) {
        setReelVersion((v) => v + 1);
      } else {
        alert("Failed to update the video");
      }
    } catch (e) {
      alert("API Error: " + e.message);
    } finally {
      setIsRerendering(false);
    }
  };

  useEffect(() => {
    let interval;
    if (jobId && isGenerating) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API}/status/${jobId}`);
          if (res.ok) {
            const data = await res.json();
            setJobStatus(data.message);
            if (data.status === 'completed') {
              setIsGenerating(false);
              setJobStatus("Done");
              const url = `${API}/download/${jobId}`;
              setResultUrl(url);
              if (mode === 'reel') fetchReelLyrics(jobId);
              if (mode === 'compose') fetchProject(jobId);
              fetchHistory();
              clearInterval(interval);
            } else if (data.status === 'failed') {
              setIsGenerating(false);
              alert('Generation failed: ' + data.message);
              clearInterval(interval);
            }
          }
        } catch (error) {
          console.error("Polling error:", error);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [jobId, isGenerating, mode]);

  const handlePlayPreview = () => {
    if (!wavesurfer.current) return;
    if (isPlayingPreview) {
      wavesurfer.current.pause();
      setIsPlayingPreview(false);
    } else {
      if (regions.current && regions.current.getRegions().length > 0) {
        regions.current.getRegions()[0].play();
        setIsPlayingPreview(true);
      } else {
        wavesurfer.current.play();
        setIsPlayingPreview(true);
      }
    }
  };

  useEffect(() => {
    if (wavesurfer.current) {
      wavesurfer.current.on('pause', () => setIsPlayingPreview(false));
      wavesurfer.current.on('play', () => setIsPlayingPreview(true));
    }
  }, [wavesurfer.current]);

  const handleGenerate = async () => {
    if (!file) return;
    
    setIsGenerating(true);
    setDisplayProgress(5);
    setJobStatus("Uploading...");
    setResultUrl(null);
    setLyricLines([]);
    setKaraokePitch(0);
    setKaraokeTempo(1.0);
    setKaraokeTweakError('');
    setKaraokeBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('start', region.start.toString());
    formData.append('length', (region.end - region.start).toString());
    formData.append('mode', mode);

    if (mode === 'reel') {
      formData.append('language', language);
      if (bgImage) formData.append('image', bgImage);
    }

    if (mode === 'compose') {
      formData.append('instrument', instrument);
      formData.append('note_smoothing', settings.note_smoothing.toString());
      formData.append('pitch_bend', settings.pitch_bend.toString());
      formData.append('tempo', settings.tempo.toString());
    }

    try {
      const res = await fetch(`${API}/generate`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        setJobId(data.job_id);
      } else {
        alert("Failed to start generation");
        setIsGenerating(false);
      }
    } catch (e) {
      alert("API Error: " + e.message);
      setIsGenerating(false);
    }
  };

  const openHistoryItem = (item) => {
    setActiveHistoryItem(item);
    setResultUrl(`${API}/download/${item.job_id}`);
    setMode('view_history');
  };

  if (mode === 'lyrics') {
    return <LyricsEditor onBack={() => setMode(null)} />;
  }

  if (mode === 'hookreel') {
    return <LyricsEditor auto onBack={() => setMode(null)} />;
  }

  if (mode === 'remix') {
    return <RemixStudio onBack={() => setMode(null)} />;
  }

  if (mode === 'voice_changer') {
    return <VoiceChanger onBack={() => setMode(null)} />;
  }

  if (mode === 'extract') {
    return <AudioExtractor onBack={() => setMode(null)} />;
  }

  // ----------------------------------------------------
  // RENDER: HOME SCREEN (MODE SELECTION)
  // ----------------------------------------------------
  if (mode === null) {
    return (
      <div className="min-h-[100dvh] bg-[#0f0f11] text-zinc-100 p-4 sm:p-8 font-sans flex items-start sm:items-center justify-center flex-col">
        <div className="w-full max-w-3xl bg-[#161618] border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl p-4 sm:p-6 text-center mb-4 mt-4">
          <div className="bg-indigo-500/20 p-3 rounded-2xl inline-block mb-3">
            <Music className="w-8 h-8 text-indigo-400" />
          </div>
          <h1 className="text-2xl font-bold mb-1">Welcome to TuneShift</h1>
          <p className="text-zinc-400 mb-6 text-sm">What would you like to do today?</p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <button
              onClick={() => setMode('hookreel')}
              className="bg-gradient-to-r from-fuchsia-500/10 to-indigo-500/10 hover:from-fuchsia-500/20 hover:to-indigo-500/20 border border-fuchsia-500/30 hover:border-fuchsia-500/60 p-4 rounded-xl transition-all flex items-center justify-center gap-4 group md:col-span-2 lg:col-span-3 text-left"
            >
              <div className="bg-fuchsia-500/10 p-3 rounded-full group-hover:bg-fuchsia-500/20 transition-colors shrink-0">
                <Sparkles className="w-6 h-6 text-fuchsia-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Hook to Reel</h2>
                <p className="text-xs text-zinc-400">Choose a song, then pick its best part (or let the app pick it). The lyrics and a picture are made for you, ready to download as a Reel.</p>
              </div>
            </button>

            <button
              onClick={() => setMode('lyrics')}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-amber-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group"
            >
              <div className="bg-amber-500/10 p-3 rounded-full group-hover:bg-amber-500/20 transition-colors">
                <Languages className="w-6 h-6 text-amber-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Song to Lyrics</h2>
                <p className="text-xs text-zinc-500">Get the lyrics of any song as Hinglish text, synced with the music.</p>
              </div>
            </button>

            <button
              onClick={() => setMode('remix')}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-emerald-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group"
            >
              <div className="bg-emerald-500/10 p-3 rounded-full group-hover:bg-emerald-500/20 transition-colors">
                <Headphones className="w-6 h-6 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Music Remix</h2>
                <p className="text-xs text-zinc-500">Play the music of a song on another instrument, or turn it into a lofi version.</p>
              </div>
            </button>

            <button
              onClick={() => setMode('voice_changer')}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-violet-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group"
            >
              <div className="bg-violet-500/10 p-3 rounded-full group-hover:bg-violet-500/20 transition-colors">
                <Drama className="w-6 h-6 text-violet-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Voice Changer</h2>
                <p className="text-xs text-zinc-500">Upload any song and turn the singer's voice into a character — chipmunk, robot, giant and more.</p>
              </div>
            </button>

            <button
              onClick={() => { setFile(null); setResultUrl(null); setMode('remove_voice'); }}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-indigo-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group"
            >
              <div className="bg-rose-500/10 p-3 rounded-full group-hover:bg-rose-500/20 transition-colors">
                <MicOff className="w-6 h-6 text-rose-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Remove Voice</h2>
                <p className="text-xs text-zinc-500">Strip the vocals from any song to create a clean instrumental karaoke track.</p>
              </div>
            </button>

            <button
              onClick={() => { setFile(null); setResultUrl(null); setMode('vocals_only'); }}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-teal-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group"
            >
              <div className="bg-teal-500/10 p-3 rounded-full group-hover:bg-teal-500/20 transition-colors">
                <Mic className="w-6 h-6 text-teal-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Extract Vocals</h2>
                <p className="text-xs text-zinc-500">The opposite of Remove Voice: keep only the singer, strip out all the music.</p>
              </div>
            </button>

            <button 
              onClick={() => { setFile(null); setResultUrl(null); setProject(null); setEditError(''); setAiReply(''); setMode('compose'); }}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-indigo-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group md:col-span-1 lg:col-span-1"
            >
              <div className="bg-indigo-500/10 p-3 rounded-full group-hover:bg-indigo-500/20 transition-colors">
                <Wand2 className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Compose New Song</h2>
                <p className="text-xs text-zinc-500">Extract the melody and completely replace it with a new instrument.</p>
              </div>
            </button>

            <button
              onClick={() => { setFile(null); setResultUrl(null); setBgImage(null); setLyricLines([]); setMode('reel'); }}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-fuchsia-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group"
            >
              <div className="bg-fuchsia-500/10 p-3 rounded-full group-hover:bg-fuchsia-500/20 transition-colors">
                <Film className="w-6 h-6 text-fuchsia-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Reel Video</h2>
                <p className="text-xs text-zinc-500">Make a karaoke lyric video with your image, ready to post as a Reel.</p>
              </div>
            </button>

            <button
              onClick={() => setMode('extract')}
              className="bg-zinc-900/50 hover:bg-zinc-800/80 border border-zinc-800 hover:border-sky-500/50 p-4 rounded-xl transition-all flex flex-col items-center gap-3 group"
            >
              <div className="bg-sky-500/10 p-3 rounded-full group-hover:bg-sky-500/20 transition-colors">
                <AudioLines className="w-6 h-6 text-sky-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold mb-1 text-zinc-200">Video to Audio</h2>
                <p className="text-xs text-zinc-500">Take the sound out of an MP4 or any video as an MP3, WAV or M4A file.</p>
              </div>
            </button>
          </div>
        </div>

        {/* History Section on Home Screen */}
        {history.length > 0 && (
          <div className="w-full max-w-3xl">
            <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
              <Clock className="w-5 h-5 text-zinc-400" />
              Cloud History
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {history.map((item, idx) => (
                <div
                  key={idx}
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (editingHistoryId !== item.job_id) openHistoryItem(item); }}
                  onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && editingHistoryId !== item.job_id) openHistoryItem(item); }}
                  className="bg-[#161618] border border-zinc-800 hover:border-indigo-500/30 p-4 rounded-xl flex items-center gap-4 transition-all text-left group cursor-pointer"
                >
                  <div className={`p-3 rounded-lg transition-colors shrink-0 ${
                    item.mode === 'remove_voice' ? 'bg-rose-500/10 text-rose-400 group-hover:bg-rose-500/20'
                    : item.mode === 'vocals_only' ? 'bg-teal-500/10 text-teal-400 group-hover:bg-teal-500/20'
                    : item.mode === 'reel' ? 'bg-fuchsia-500/10 text-fuchsia-400 group-hover:bg-fuchsia-500/20'
                    : 'bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-500/20'}`}>
                    <PlayCircle className="w-6 h-6" />
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {editingHistoryId === item.job_id ? (
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          autoFocus
                          value={editingValue}
                          maxLength={200}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRenameHistoryItem(item.job_id);
                            if (e.key === 'Escape') cancelRenameHistoryItem();
                          }}
                          className="flex-1 min-w-0 bg-zinc-900 border border-indigo-500/50 rounded-lg px-2 py-1 text-sm text-zinc-200"
                        />
                        <button onClick={() => saveRenameHistoryItem(item.job_id)} className="p-1.5 text-emerald-400 hover:text-emerald-300 transition-colors shrink-0" title="Save">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={cancelRenameHistoryItem} className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors shrink-0" title="Cancel">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="font-medium text-zinc-200 truncate">{item.filename}</p>
                        <div className="flex gap-2 text-xs text-zinc-500 mt-1">
                          <span className="capitalize">{item.mode.replace('_', ' ')}</span>
                          <span>•</span>
                          <span>{new Date(item.created_at).toLocaleDateString()}</span>
                        </div>
                      </>
                    )}
                  </div>
                  {editingHistoryId !== item.job_id && (
                    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); startRenameHistoryItem(item); }}
                        className="p-1.5 text-zinc-500 hover:text-indigo-400 transition-colors"
                        title="Rename"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteHistoryItem(item); }}
                        disabled={deletingHistoryId === item.job_id}
                        className="p-1.5 text-zinc-500 hover:text-rose-400 transition-colors disabled:opacity-50"
                        title="Delete"
                      >
                        {deletingHistoryId === item.job_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ----------------------------------------------------
  // RENDER: EDITOR / VIEW HISTORY SCREEN
  // ----------------------------------------------------
  return (
    <div className="min-h-[100dvh] bg-[#0f0f11] text-zinc-100 p-4 sm:p-8 font-sans flex items-start sm:items-center justify-center">
      <div className="w-full max-w-5xl bg-[#161618] border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl my-auto">
        
        {/* Header */}
        <div className="p-6 border-b border-zinc-800 flex items-center gap-4">
          <button
            onClick={() => {
              setMode(null);
              setFile(null);
              setResultUrl(null);
              setActiveHistoryItem(null);
              setProject(null);
              setEditError('');
              setAiReply('');
              if(wavesurfer.current) wavesurfer.current.destroy();
            }}
            className="p-2 bg-zinc-900 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-white"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          
          <div className="bg-indigo-500/20 p-2 rounded-lg">
            {mode === 'view_history' ? <Clock className="w-6 h-6 text-indigo-400" /> :
             mode === 'remove_voice' ? <MicOff className="w-6 h-6 text-indigo-400" /> :
             mode === 'vocals_only' ? <Mic className="w-6 h-6 text-indigo-400" /> :
             mode === 'reel' ? <Film className="w-6 h-6 text-indigo-400" /> :
             <Music className="w-6 h-6 text-indigo-400" />}
          </div>

          <div>
            <h1 className="text-xl font-semibold">
              {mode === 'view_history' ? 'Track History' :
               mode === 'remove_voice' ? 'Karaoke Creator' :
               mode === 'vocals_only' ? 'Vocal Extractor' :
               mode === 'reel' ? 'Reel Maker' : 'TuneShift Composer'}
            </h1>
            <p className="text-sm text-zinc-400">
              {mode === 'view_history' ? activeHistoryItem?.filename :
               mode === 'remove_voice' ? 'Remove vocals from your track' :
               mode === 'vocals_only' ? 'Keep only the singer, strip the music' :
               mode === 'reel' ? 'Karaoke lyric video for Reels' : 'Extract & convert melody'}
            </p>
          </div>
        </div>

        {/* Main Content Area */}
        <div className={`p-6 grid grid-cols-1 ${mode === 'compose' ? 'md:grid-cols-2' : 'md:grid-cols-1 max-w-3xl mx-auto'} gap-8`}>
          
          {mode === 'view_history' ? (
            <div className="space-y-6">
              <div className="bg-zinc-900/50 p-6 rounded-2xl border border-zinc-800/50">
                <h2 className="text-xl font-medium mb-1 text-zinc-200">{activeHistoryItem?.filename}</h2>
                <div className="flex gap-2 text-sm text-zinc-500 mb-6">
                  <span className="capitalize px-2 py-1 bg-zinc-800 rounded">{activeHistoryItem?.mode.replace('_', ' ')}</span>
                  <span className="px-2 py-1 bg-zinc-800 rounded">{new Date(activeHistoryItem?.created_at).toLocaleString()}</span>
                </div>
                
                {resultUrl && activeHistoryItem?.mode === 'reel' ? (
                  <video controls className="w-full max-w-xs mx-auto rounded-xl mb-6 bg-black" src={resultUrl} />
                ) : resultUrl ? (
                  <audio controls className="w-full h-12 custom-audio mb-6" src={resultUrl} autoPlay />
                ) : (
                  <div className="flex items-center gap-2 text-zinc-400 mb-6 bg-zinc-800/50 p-3 rounded-lg">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Processing in cloud...</span>
                  </div>
                )}
                
                <div className="flex gap-3">
                  <a 
                    href={resultUrl}
                    download={`TuneShift_${activeHistoryItem?.mode}.${activeHistoryItem?.mode === 'reel' ? 'mp4' : 'mp3'}`}
                    target="_blank"
                    className="flex-1 bg-white hover:bg-zinc-200 text-zinc-900 py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg"
                  >
                    <Download className="w-4 h-4" />
                    {activeHistoryItem?.mode === 'reel' ? 'Download MP4' : 'Download MP3'}
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Core Inputs (File & Trimmer) */}
              <div className="space-y-8">
                <div className="space-y-4">
                  <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                    Audio Source
                  </h2>
                  
                  {!file ? (
                    <label className="border-2 border-dashed border-zinc-700/50 hover:border-indigo-500/50 hover:bg-zinc-800/30 transition-all rounded-xl p-6 sm:p-10 flex flex-col items-center justify-center gap-3 cursor-pointer bg-zinc-900/30 min-h-[160px]">
                      <Upload className="w-8 h-8 text-zinc-500" />
                      <div className="text-center">
                        <span className="font-medium text-indigo-400 hover:text-indigo-300 transition-colors">Select a song</span>
                        <p className="text-sm text-zinc-500 mt-1">MP3 or WAV</p>
                      </div>
                      <input type="file" accept="audio/*" className="hidden" onChange={(e) => {
                        if(e.target.files[0]) setFile(e.target.files[0]);
                      }} />
                    </label>
                  ) : (
                    <div className="space-y-3 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800/50">
                      <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-300 truncate max-w-[200px]">{file.name}</span>
                        <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">Total: {formatTime(totalDuration)}</span>
                      </div>
                      <button onClick={() => setFile(null)} className="text-zinc-500 hover:text-indigo-400 transition-colors">Replace</button>
                    </div>
                    <div className="w-full h-[60px] relative" ref={waveformRef} />
                    <div className="flex items-center justify-between text-xs text-zinc-400 font-mono mt-2 bg-zinc-950/50 p-2 rounded-lg border border-zinc-800/50">
                      <div className="flex flex-col items-center">
                        <span className="text-zinc-600 mb-1">Start</span>
                        <span className="bg-zinc-800 px-2 py-1 rounded border border-zinc-700">{formatTime(region.start)}</span>
                      </div>
                      <button 
                        onClick={handlePlayPreview}
                        className="flex flex-col items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors group"
                      >
                        <div className="bg-indigo-500/20 group-hover:bg-indigo-500/30 p-2 rounded-full transition-colors">
                          {isPlayingPreview ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        </div>
                        <span>Preview {formatTime(region.end - region.start)}</span>
                      </button>
                      <div className="flex flex-col items-center">
                        <span className="text-zinc-600 mb-1">End</span>
                        <span className="bg-zinc-800 px-2 py-1 rounded border border-zinc-700">{formatTime(region.end)}</span>
                      </div>
                    </div>
                    </div>
                  )}
                </div>

                {mode === 'compose' && (
                  <div className="space-y-4">
                    <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                      Target Instrument
                      {project && <span className="normal-case text-zinc-600 font-normal">— tap to try another, instantly</span>}
                    </h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {instrumentsList.map((inst) => (
                        <button
                          key={inst.id}
                          disabled={editing}
                          onClick={() => {
                            setInstrument(inst.id);
                            if (project) applyEdit({ instrument: inst.id });
                          }}
                          className={`py-3 px-4 rounded-xl text-sm font-medium transition-all border disabled:opacity-50 ${
                            instrument === inst.id
                            ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                            : 'border-zinc-800/50 bg-zinc-900/30 hover:border-zinc-700 text-zinc-400'
                          }`}
                        >
                          {inst.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                {mode === 'reel' && (
                  <>
                    <div className="space-y-4">
                      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-fuchsia-500"></span>
                        Background Image <span className="normal-case text-zinc-600">(optional)</span>
                      </h2>
                      {bgPreview ? (
                        <div className="flex items-center gap-4 bg-zinc-900/50 rounded-xl p-3 border border-zinc-800/50">
                          <img src={bgPreview} alt="Background" className="w-16 h-28 object-cover rounded-lg" />
                          <div className="flex-1 text-sm text-zinc-300 truncate">{bgImage?.name}</div>
                          <button onClick={() => setBgImage(null)} className="text-zinc-500 hover:text-fuchsia-400 transition-colors text-sm">Remove</button>
                        </div>
                      ) : (
                        <label className="border-2 border-dashed border-zinc-700/50 hover:border-fuchsia-500/50 hover:bg-zinc-800/30 transition-all rounded-xl p-6 flex items-center justify-center gap-3 cursor-pointer bg-zinc-900/30">
                          <ImageIcon className="w-6 h-6 text-zinc-500" />
                          <span className="text-sm text-zinc-400">Pick an image, or leave empty for a gradient</span>
                          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => {
                            if (e.target.files[0]) setBgImage(e.target.files[0]);
                          }} />
                        </label>
                      )}
                    </div>

                    <div className="space-y-4">
                      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-fuchsia-500"></span>
                        Song Language
                      </h2>
                      <div className="grid grid-cols-3 gap-2">
                        {LANGUAGES.map((lang) => (
                          <button
                            key={lang.id}
                            onClick={() => setLanguage(lang.id)}
                            className={`py-3 px-4 rounded-xl text-sm font-medium transition-all border ${
                              language === lang.id
                              ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-300'
                              : 'border-zinc-800/50 bg-zinc-900/30 hover:border-zinc-700 text-zinc-400'
                            }`}
                          >
                            {lang.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="pt-4">
                      {!isGenerating && !resultUrl ? (
                        <button
                          onClick={handleGenerate}
                          disabled={!file}
                          className="w-full bg-fuchsia-600 hover:bg-fuchsia-500 text-white disabled:bg-zinc-800 disabled:text-zinc-500 py-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg shadow-fuchsia-500/20 disabled:shadow-none text-lg"
                        >
                          Create Reel Video
                        </button>
                      ) : isGenerating ? (
                        <div className="space-y-4 bg-zinc-900/30 p-6 rounded-xl border border-zinc-800/50">
                          <div className="flex justify-between text-sm text-zinc-400">
                            <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-fuchsia-500" /> {jobStatus}</span>
                            <span className="font-mono text-fuchsia-400">{displayProgress}%</span>
                          </div>
                          <div className="w-full h-3 bg-zinc-800 rounded-full overflow-hidden border border-zinc-700/50">
                            <div
                              className="h-full bg-gradient-to-r from-fuchsia-600 via-fuchsia-500 to-fuchsia-400 transition-all duration-700 ease-out shadow-[0_0_15px_rgba(217,70,239,0.5)]"
                              style={{ width: `${displayProgress}%` }}
                            />
                          </div>
                          <p className="text-xs text-zinc-500 text-center animate-pulse">This usually takes 2-3 minutes depending on song length.</p>
                        </div>
                      ) : (
                        <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 bg-fuchsia-500/5 p-4 rounded-xl border border-fuchsia-500/20">
                          <video
                            key={reelVersion}
                            controls
                            className="w-full max-w-xs mx-auto rounded-xl bg-black"
                            src={`${resultUrl}?v=${reelVersion}`}
                          />

                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <h3 className="text-sm font-semibold text-zinc-300">Lyrics</h3>
                              <span className="text-xs text-zinc-500">Fix any wrong words, then update the video</span>
                            </div>
                            {lyricLines.length === 0 && (
                              <p className="text-xs text-zinc-500 bg-zinc-900/50 p-3 rounded-lg">No lyrics were detected. Add lines with their timing (in seconds) to show them in the video.</p>
                            )}
                            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                              {lyricLines.map((line, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                  <input
                                    type="number" step="0.1" min="0" value={Number(line.start.toFixed(1))}
                                    onChange={(e) => updateLine(idx, { start: parseFloat(e.target.value) || 0 })}
                                    className="w-16 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-2 text-xs font-mono text-zinc-300"
                                    title="Start (s)"
                                  />
                                  <input
                                    type="number" step="0.1" min="0" value={Number(line.end.toFixed(1))}
                                    onChange={(e) => updateLine(idx, { end: parseFloat(e.target.value) || 0 })}
                                    className="w-16 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-2 text-xs font-mono text-zinc-300"
                                    title="End (s)"
                                  />
                                  <input
                                    type="text" value={line.text} maxLength={200}
                                    onChange={(e) => updateLine(idx, { text: e.target.value })}
                                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200"
                                  />
                                  <button
                                    onClick={() => setLyricLines((lines) => lines.filter((_, i) => i !== idx))}
                                    className="p-2 text-zinc-500 hover:text-rose-400 transition-colors"
                                    title="Remove line"
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div className="flex gap-3">
                              <button
                                onClick={addLine}
                                className="px-4 py-2 border border-zinc-700 hover:bg-zinc-800 text-zinc-300 rounded-lg text-sm flex items-center gap-1 transition-all"
                              >
                                <Plus className="w-4 h-4" /> Add line
                              </button>
                              <button
                                onClick={handleRerender}
                                disabled={isRerendering}
                                className="flex-1 bg-fuchsia-600 hover:bg-fuchsia-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2"
                              >
                                {isRerendering && <Loader2 className="w-4 h-4 animate-spin" />}
                                {isRerendering ? 'Updating video...' : 'Update video'}
                              </button>
                            </div>
                          </div>

                          <div className="flex gap-3">
                            <a
                              href={`${resultUrl}?v=${reelVersion}`}
                              download="Reel_Video.mp4"
                              target="_blank"
                              className="flex-1 bg-white hover:bg-zinc-200 text-zinc-900 py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg"
                            >
                              <Download className="w-4 h-4" />
                              Download MP4
                            </a>
                            <button
                              onClick={() => { setResultUrl(null); setLyricLines([]); }}
                              className="px-6 border border-zinc-700 hover:bg-zinc-800 text-zinc-300 rounded-xl font-medium transition-all"
                            >
                              New
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Generate Area for Remove Voice / Extract Vocals modes (opposite outputs, same flow) */}
                {(mode === 'remove_voice' || mode === 'vocals_only') && (
                  <div className="pt-4">
                    {!isGenerating && !resultUrl ? (
                      <button
                        onClick={handleGenerate}
                        disabled={!file}
                        className={`w-full text-white disabled:bg-zinc-800 disabled:text-zinc-500 py-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg disabled:shadow-none text-lg ${
                          mode === 'vocals_only'
                            ? 'bg-teal-600 hover:bg-teal-500 shadow-teal-500/20'
                            : 'bg-rose-600 hover:bg-rose-500 shadow-rose-500/20'
                        }`}
                      >
                        {mode === 'vocals_only' ? 'Extract Vocals & Generate' : 'Remove Vocals & Generate'}
                      </button>
                    ) : isGenerating ? (
                      <div className="space-y-4 bg-zinc-900/30 p-6 rounded-xl border border-zinc-800/50">
                        <div className="flex justify-between text-sm text-zinc-400">
                          <span className={`flex items-center gap-2`}><Loader2 className={`w-4 h-4 animate-spin ${mode === 'vocals_only' ? 'text-teal-500' : 'text-rose-500'}`} /> {jobStatus}</span>
                          <span className={`font-mono ${mode === 'vocals_only' ? 'text-teal-400' : 'text-rose-400'}`}>{displayProgress}%</span>
                        </div>
                        <div className="w-full h-3 bg-zinc-800 rounded-full overflow-hidden border border-zinc-700/50">
                          <div
                            className={`h-full transition-all duration-700 ease-out ${
                              mode === 'vocals_only'
                                ? 'bg-gradient-to-r from-teal-600 via-teal-500 to-teal-400 shadow-[0_0_15px_rgba(20,184,166,0.5)]'
                                : 'bg-gradient-to-r from-rose-600 via-rose-500 to-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.5)]'
                            }`}
                            style={{ width: `${displayProgress}%` }}
                          />
                        </div>
                        <p className="text-xs text-zinc-500 text-center animate-pulse">This usually takes 1-2 minutes depending on song length.</p>
                      </div>
                    ) : (
                      <div className={`space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 p-4 rounded-xl border ${
                        mode === 'vocals_only' ? 'bg-teal-500/5 border-teal-500/20' : 'bg-rose-500/5 border-rose-500/20'
                      }`}>
                        {karaokeTweaking && (
                          <span className="flex items-center gap-1.5 text-xs text-indigo-400">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Updating…
                          </span>
                        )}
                        {!karaokeTweaking && karaokeTweakError && <p className="text-xs text-rose-400">{karaokeTweakError}</p>}
                        <audio key={karaokeBlobUrl || resultUrl} controls className="w-full h-10 custom-audio" src={karaokeBlobUrl || resultUrl} />

                        {/* Instant pitch/tempo, no need to generate again: re-uses the already separated part */}
                        <div className="space-y-3 bg-zinc-900/30 rounded-xl p-3 border border-zinc-800/50">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <label className="text-xs font-medium text-zinc-400">Pitch</label>
                              <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded border border-zinc-700 font-mono">
                                {karaokePitch > 0 ? `+${karaokePitch}` : karaokePitch} semitones
                              </span>
                            </div>
                            <input
                              type="range" min="-12" max="12" step="1"
                              value={karaokePitch}
                              disabled={karaokeTweaking}
                              onChange={(e) => {
                                const pitch = parseInt(e.target.value, 10);
                                setKaraokePitch(pitch);
                                applyKaraokeTweakDebounced({ pitch });
                              }}
                              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                            />
                          </div>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <label className="text-xs font-medium text-zinc-400">Tempo</label>
                              <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded border border-zinc-700 font-mono">{karaokeTempo}x</span>
                            </div>
                            <input
                              type="range" min="0.5" max="2.0" step="0.1"
                              value={karaokeTempo}
                              disabled={karaokeTweaking}
                              onChange={(e) => {
                                const tempo = parseFloat(e.target.value);
                                setKaraokeTempo(tempo);
                                applyKaraokeTweakDebounced({ tempo });
                              }}
                              className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                            />
                          </div>
                        </div>

                        <div className="flex gap-3">
                          <a
                            href={karaokeBlobUrl || resultUrl}
                            download={mode === 'vocals_only' ? 'Vocals_Only.mp3' : 'Instrumental_Track.mp3'}
                            target="_blank"
                            className="flex-1 bg-white hover:bg-zinc-200 text-zinc-900 py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg"
                          >
                            <Download className="w-4 h-4" />
                            {mode === 'vocals_only' ? 'Download Vocals' : 'Download Instrumental'}
                          </a>
                          <button
                            onClick={() => {
                              setResultUrl(null);
                              setKaraokeTweakError('');
                              setKaraokeBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
                            }}
                            className="px-6 border border-zinc-700 hover:bg-zinc-800 text-zinc-300 rounded-xl font-medium transition-all"
                          >
                            New
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right Column: Settings & Generation (Only for compose) */}
              {mode === 'compose' && (
                <div className="flex flex-col h-full space-y-8">
                  
                  <div className="space-y-6 flex-1 bg-zinc-900/20 p-6 rounded-2xl border border-zinc-800/50">
                    <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-2 mb-2">
                      <SlidersHorizontal className="w-4 h-4" />
                      Customization Settings
                    </h2>
                    
                    {/* Tempo Slider */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-zinc-300">Tempo</label>
                        <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded border border-zinc-700 font-mono">{settings.tempo}x</span>
                      </div>
                      <input
                        type="range" min="0.5" max="2.0" step="0.1"
                        value={settings.tempo}
                        onChange={(e) => {
                          const tempo = parseFloat(e.target.value);
                          setSettings({...settings, tempo});
                          if (project) applyEditDebounced({ tempo });
                        }}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                      />
                    </div>

                    {/* Note Smoothing Toggle */}
                    <div className="flex items-center justify-between border-t border-zinc-800/50 pt-5">
                      <div>
                        <label className="text-sm font-medium text-zinc-300">Note Smoothing</label>
                        <p className="text-xs text-zinc-500 mt-1">Clean up small glitches from AI</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={settings.note_smoothing} onChange={(e) => {
                          const note_smoothing = e.target.checked;
                          setSettings({...settings, note_smoothing});
                          if (project) applyEdit({ note_smoothing });
                        }} />
                        <div className="w-10 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                      </label>
                    </div>

                    {/* Pitch Bend Toggle */}
                    <div className="flex items-center justify-between border-t border-zinc-800/50 pt-5">
                      <div>
                        <label className="text-sm font-medium text-zinc-300">Allow Pitch Bends</label>
                        <p className="text-xs text-zinc-500 mt-1">Smooth sliding between notes</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={settings.pitch_bend} onChange={(e) => {
                          const pitch_bend = e.target.checked;
                          setSettings({...settings, pitch_bend});
                          if (project) applyEdit({ pitch_bend });
                        }} />
                        <div className="w-10 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                      </label>
                    </div>

                    {/* Live-only tweaks: these are decided by the AI composer, so they only make sense once a version exists */}
                    {project && (
                      <>
                        <div className="space-y-3 border-t border-zinc-800/50 pt-5">
                          <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-zinc-300">Transpose</label>
                            <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded border border-zinc-700 font-mono">
                              {project.transpose > 0 ? `+${project.transpose}` : project.transpose} semitones
                            </span>
                          </div>
                          <input
                            type="range" min="-24" max="24" step="1"
                            value={project.transpose}
                            disabled={editing}
                            onChange={(e) => {
                              const transpose = parseInt(e.target.value, 10);
                              setProject({ ...project, transpose });
                              applyEditDebounced({ transpose });
                            }}
                            className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                          />
                        </div>

                        <div className="flex items-center justify-between border-t border-zinc-800/50 pt-5">
                          <div>
                            <label className="text-sm font-medium text-zinc-300">Accompaniment</label>
                            <p className="text-xs text-zinc-500 mt-1">Background chords + bass</p>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={project.accompaniment} disabled={editing} onChange={(e) => applyEdit({ accompaniment: e.target.checked })} />
                            <div className="w-10 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                          </label>
                        </div>

                        {project.accompaniment && (
                          <>
                            <div className="border-t border-zinc-800/50 pt-5 space-y-2">
                              <label className="text-sm font-medium text-zinc-300">Accompaniment style</label>
                              <div className="grid grid-cols-3 gap-2">
                                {['block', 'arpeggio', 'strum'].map((style) => (
                                  <button
                                    key={style}
                                    disabled={editing}
                                    onClick={() => applyEdit({ accompaniment_style: style })}
                                    className={`py-2 rounded-lg text-xs font-medium border capitalize transition-all disabled:opacity-50 ${
                                      project.accompaniment_style === style
                                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                                        : 'border-zinc-800/50 bg-zinc-900/30 hover:border-zinc-700 text-zinc-400'
                                    }`}
                                  >
                                    {style}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="space-y-3 pt-2">
                              <div className="flex items-center justify-between">
                                <label className="text-sm font-medium text-zinc-300">Accompaniment volume</label>
                                <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded border border-zinc-700 font-mono">{Math.round(project.accompaniment_volume * 100)}%</span>
                              </div>
                              <input
                                type="range" min="0" max="1" step="0.05"
                                value={project.accompaniment_volume}
                                disabled={editing}
                                onChange={(e) => {
                                  const accompaniment_volume = parseFloat(e.target.value);
                                  setProject({ ...project, accompaniment_volume });
                                  applyEditDebounced({ accompaniment_volume });
                                }}
                                className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                              />
                            </div>
                          </>
                        )}

                        <div className="space-y-3 border-t border-zinc-800/50 pt-5">
                          <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-zinc-300">Melody volume</label>
                            <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded border border-zinc-700 font-mono">{Math.round(project.melody_volume * 100)}%</span>
                          </div>
                          <input
                            type="range" min="0" max="1" step="0.05"
                            value={project.melody_volume}
                            disabled={editing}
                            onChange={(e) => {
                              const melody_volume = parseFloat(e.target.value);
                              setProject({ ...project, melody_volume });
                              applyEditDebounced({ melody_volume });
                            }}
                            className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                          />
                        </div>

                        {/* AI edit: say what you want changed in plain Hindi/English/Hinglish */}
                        <div className="space-y-2 border-t border-zinc-800/50 pt-5">
                          <label className="text-sm font-medium text-zinc-300">Or just say what you want</label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={aiInstruction}
                              disabled={editing}
                              onChange={(e) => setAiInstruction(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') applyAiEdit(); }}
                              placeholder="jaise: 'thoda dheere kar do' ya 'bass halka kar do'"
                              className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 disabled:opacity-50"
                            />
                            <button
                              onClick={applyAiEdit}
                              disabled={editing || !aiInstruction.trim()}
                              className="px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
                            >
                              {editing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                            </button>
                          </div>
                          {aiReply && <p className="text-xs text-emerald-400">{aiReply}</p>}
                          {editError && <p className="text-xs text-rose-400">{editError}</p>}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Generate Area for Compose mode */}
                  <div className="pt-2">
                    {!isGenerating && !resultUrl ? (
                      <button 
                        onClick={handleGenerate}
                        disabled={!file}
                        className="w-full bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-zinc-800 disabled:text-zinc-500 py-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20 disabled:shadow-none text-lg"
                      >
                        Generate Instrumental
                      </button>
                    ) : isGenerating ? (
                      <div className="space-y-4 bg-zinc-900/30 p-6 rounded-xl border border-zinc-800/50">
                        <div className="flex justify-between text-sm text-zinc-400">
                          <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> {jobStatus}</span>
                          <span className="font-mono text-indigo-400">{displayProgress}%</span>
                        </div>
                        <div className="w-full h-3 bg-zinc-800 rounded-full overflow-hidden border border-zinc-700/50">
                          <div 
                            className="h-full bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-400 transition-all duration-700 ease-out shadow-[0_0_15px_rgba(99,102,241,0.5)]" 
                            style={{ width: `${displayProgress}%` }}
                          />
                        </div>
                        <p className="text-xs text-zinc-500 text-center animate-pulse">This usually takes 1-2 minutes depending on song length.</p>
                      </div>
                    ) : (
                      <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 bg-indigo-500/5 p-4 rounded-xl border border-indigo-500/20">
                        {editing && (
                          <span className="flex items-center gap-1.5 text-xs text-indigo-400">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Updating…
                          </span>
                        )}
                        <audio controls className="w-full h-10 custom-audio" src={project ? `${resultUrl}?v=${project.version}` : resultUrl} />

                        <div className="flex gap-3">
                          <a
                            href={project ? `${resultUrl}?v=${project.version}` : resultUrl}
                            download="TuneShift_Result.mp3"
                            target="_blank"
                            className="flex-1 bg-white hover:bg-zinc-200 text-zinc-900 py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg"
                          >
                            <Download className="w-4 h-4" />
                            Download MP3
                          </a>
                          <button
                            onClick={() => { setResultUrl(null); setProject(null); setEditError(''); setAiReply(''); }}
                            className="px-6 border border-zinc-700 hover:bg-zinc-800 text-zinc-300 rounded-xl font-medium transition-all"
                          >
                            New
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
