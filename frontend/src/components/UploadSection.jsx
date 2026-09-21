import { Upload } from 'lucide-react';
import Section from './Section';

export default function UploadSection({ file, onFileChange, containerRef }) {
  return (
    <Section step={1} title="Upload & Select">
      {!file ? (
        <label className="border-2 border-dashed border-zinc-700 hover:border-indigo-500 transition-colors rounded-xl p-12 flex flex-col items-center justify-center gap-4 cursor-pointer bg-zinc-900/50">
          <Upload className="w-8 h-8 text-zinc-400" />
          <div className="text-center">
            <span className="font-medium text-indigo-400">Click to upload</span> or drag and drop
            <p className="text-xs text-zinc-500 mt-1">MP3 or WAV up to 10MB</p>
          </div>
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => e.target.files[0] && onFileChange(e.target.files[0])}
          />
        </label>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium truncate max-w-[300px]">{file.name}</span>
            <button onClick={() => onFileChange(null)} className="text-zinc-400 hover:text-white transition-colors">
              Change file
            </button>
          </div>
          <div className="bg-zinc-950 rounded-xl p-4 border border-zinc-800">
            <div ref={containerRef} className="w-full" />
          </div>
          <p className="text-xs text-zinc-500 text-center">
            Drag the highlighted region to select the part you want to keep.
          </p>
        </div>
      )}
    </Section>
  );
}
