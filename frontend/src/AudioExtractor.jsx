import { useState, useEffect } from 'react';
import { ArrowLeft, Upload, Loader2, Download, AudioLines, Film } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const FORMATS = [
  { id: 'mp3', name: 'MP3', hint: 'Small and plays everywhere' },
  { id: 'wav', name: 'WAV', hint: 'Full quality, big file' },
  { id: 'm4a', name: 'M4A', hint: 'Good quality, small file' },
];

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default function AudioExtractor({ onBack }) {
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState('mp3');
  const [phase, setPhase] = useState('idle'); // idle | working | done | error
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { url, name, size }

  // Free the converted file when it is replaced or the page is left.
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const pickFile = (f) => {
    if (!f) return;
    setFile(f);
    setResult(null);
    setPhase('idle');
    setError('');
  };

  const extract = async () => {
    if (!file || phase === 'working') return;
    setPhase('working');
    setResult(null);
    setError('');
    const form = new FormData();
    form.append('video', file);
    form.append('format', format);
    try {
      const res = await fetch(`${API}/audio/extract`, { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
      }
      const blob = await res.blob();
      setResult({ url: URL.createObjectURL(blob), name: `${file.name.replace(/\.[^.]+$/, '') || 'audio'}.${format}`, size: blob.size });
      setPhase('done');
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  };

  const busy = phase === 'working';

  return (
    <div className="h-[100dvh] w-full bg-[#0f0f11] text-zinc-100 font-sans flex flex-col overflow-hidden">
      <header className="h-12 shrink-0 border-b border-zinc-800 bg-[#111113] flex items-center gap-3 px-4">
        <button onClick={onBack} className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors" title="Back">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <AudioLines className="w-4 h-4 text-sky-400" />
        <span className="text-sm font-semibold">Video to Audio</span>
        <span className="text-zinc-700">/</span>
        <span className="text-sm text-zinc-400 truncate">{file ? file.name : 'No video loaded'}</span>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 flex items-center justify-center">
        <div className="w-full max-w-xl space-y-5">
          {!file ? (
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); }}
              className="block border-2 border-dashed border-zinc-700 hover:border-sky-500/60 rounded-2xl p-6 sm:p-10 text-center cursor-pointer transition-colors"
            >
              <Upload className="w-9 h-9 text-zinc-600 mx-auto mb-3" />
              <p className="text-zinc-200 font-medium">Drop a video here or click to choose</p>
              <p className="text-sm text-zinc-500 mt-1">MP4, MOV, WebM, MKV and more</p>
              <input type="file" accept="video/*,.mkv" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
            </label>
          ) : (
            <>
              <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <Film className="w-5 h-5 text-zinc-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-200 truncate" title={file.name}>{file.name}</p>
                  <p className="text-[11px] text-zinc-500">{formatSize(file.size)}</p>
                </div>
                <label className={`text-xs shrink-0 ${busy ? 'text-zinc-600' : 'text-sky-400 hover:text-sky-300 cursor-pointer'}`}>
                  Replace
                  <input type="file" accept="video/*,.mkv" disabled={busy} className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
                </label>
              </div>

              <div>
                <p className="text-[11px] text-zinc-500 mb-2">Save the sound as</p>
                <div className="grid grid-cols-3 gap-2">
                  {FORMATS.map((f) => (
                    <button
                      key={f.id} onClick={() => setFormat(f.id)} disabled={busy}
                      className={`py-2.5 rounded-lg border text-left px-3 transition-colors ${
                        format === f.id ? 'border-sky-500 bg-sky-500/10' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                      }`}
                    >
                      <span className={`block text-sm font-medium ${format === f.id ? 'text-sky-300' : 'text-zinc-300'}`}>{f.name}</span>
                      <span className="block text-[10px] text-zinc-500 mt-0.5">{f.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={extract} disabled={busy}
                className="w-full py-3 rounded-xl text-sm font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <AudioLines className="w-4 h-4" />}
                {busy ? 'Taking the sound out…' : 'Get the audio'}
              </button>

              {phase === 'error' && (
                <p className="text-sm text-rose-300 text-center break-words">Something went wrong: {error}</p>
              )}

              {phase === 'done' && result && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
                  <audio controls className="w-full" src={result.url} />
                  <a
                    href={result.url} download={result.name}
                    className="w-full bg-white hover:bg-zinc-200 text-zinc-900 py-2.5 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    <Download className="w-4 h-4" /> Download {result.name} <span className="text-zinc-500 font-normal">({formatSize(result.size)})</span>
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
