import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';

export function useWaveform(file) {
  const containerRef = useRef(null);
  const [region, setRegion] = useState({ start: 0, end: 0 });

  useEffect(() => {
    if (!file || !containerRef.current) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#4f46e5',
      progressColor: '#818cf8',
      cursorColor: '#c7d2fe',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 80,
    });
    const regions = ws.registerPlugin(RegionsPlugin.create());

    ws.on('ready', () => {
      const end = ws.getDuration();
      regions.addRegion({ start: 0, end, color: 'rgba(79, 70, 229, 0.2)', drag: true, resize: true });
      setRegion({ start: 0, end });
    });
    regions.on('region-updated', (r) => setRegion({ start: r.start, end: r.end }));

    const url = URL.createObjectURL(file);
    ws.load(url);

    return () => {
      ws.destroy();
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return { containerRef, region };
}
