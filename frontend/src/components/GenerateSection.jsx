import { Download, Loader2 } from 'lucide-react';
import { downloadUrl } from '../api/tunes';
import EditPanel from './EditPanel';

export default function GenerateSection({
  canGenerate,
  isGenerating,
  statusMessage,
  jobId,
  project,
  instruments,
  isEditing,
  aiReply,
  onGenerate,
  onReset,
  onEdit,
  onAiEdit,
}) {
  if (!project) {
    return (
      <div className="pt-4 border-t border-zinc-800">
        <button
          onClick={onGenerate}
          disabled={!canGenerate || isGenerating}
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-zinc-800 disabled:text-zinc-500 py-4 rounded-xl font-bold text-lg transition-all flex items-center justify-center gap-2"
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              {statusMessage || 'Generating...'}
            </>
          ) : (
            'Generate Tune'
          )}
        </button>
      </div>
    );
  }

  const url = downloadUrl(jobId, project.version);

  return (
    <div className="pt-4 border-t border-zinc-800 space-y-4">
      <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4">
        <p className="text-sm text-indigo-300 font-medium mb-2">
          Your tune is ready ({Math.round(project.duration / project.tempo)}s)
        </p>
        <audio key={url} controls className="w-full h-10 custom-audio" src={url} />
      </div>

      <EditPanel
        project={project}
        instruments={instruments}
        busy={isEditing}
        aiReply={aiReply}
        onEdit={onEdit}
        onAiEdit={onAiEdit}
      />

      <a
        href={url}
        download="TuneShift_Result.mp3"
        className="w-full bg-zinc-100 hover:bg-white text-zinc-900 py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2"
      >
        <Download className="w-5 h-5" />
        Download MP3
      </a>
      <button onClick={onReset} className="w-full text-zinc-400 hover:text-white text-sm">
        Create another one
      </button>
    </div>
  );
}
