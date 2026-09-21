// Records the clip in the browser: the lyrics are drawn on a canvas frame by frame while the audio plays
// silently into a recorder. It takes as long as the clip is, and needs the tab to stay visible.
import { FONTS, loadFont } from './fonts';
import { SIZES, drawClipFrame } from './clipRenderer';

const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

const pickMime = () => MIME_TYPES.find((m) => window.MediaRecorder?.isTypeSupported(m));

export function canRecord() {
  return Boolean(window.MediaRecorder && pickMime() && HTMLCanvasElement.prototype.captureStream);
}

// Resolves with { blob, mime }. Rejects with Error('cancelled') or Error('hidden') if it was stopped.
export async function recordClip({ audioBuffer, lines, image, clip, onProgress, signal }) {
  const mime = pickMime();
  if (!mime) throw new Error('This browser cannot record video.');
  const [W, H] = SIZES[clip.aspect];
  await loadFont(FONTS.find((f) => f.id === clip.font) ?? FONTS[0]);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  drawClipFrame(ctx, W, H, 0, lines, image, clip);

  const audioCtx = new AudioContext();
  await audioCtx.resume();
  const sink = audioCtx.createMediaStreamDestination(); // not connected to the speakers: it records silently
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(sink);

  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...sink.stream.getAudioTracks()]);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  const duration = audioBuffer.duration + 0.3;
  let abort = null;
  const onVisibility = () => { if (document.hidden) abort = 'hidden'; };
  document.addEventListener('visibilitychange', onVisibility);

  try {
    recorder.start(500);
    const startAt = audioCtx.currentTime + 0.1;
    source.start(startAt);
    await new Promise((resolve, reject) => {
      const tick = () => {
        if (signal?.aborted) abort = 'cancelled';
        if (abort) { reject(new Error(abort)); return; }
        const t = audioCtx.currentTime - startAt;
        drawClipFrame(ctx, W, H, Math.max(0, t), lines, image, clip);
        onProgress?.(Math.min(1, Math.max(0, t) / duration), Math.max(0, t), duration);
        if (t >= duration) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    try { source.stop(); } catch { /* it had already ended */ }
    audioCtx.close();
  }
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), mime };
}
