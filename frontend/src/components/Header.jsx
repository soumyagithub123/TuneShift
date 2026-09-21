import { Music } from 'lucide-react';

export default function Header() {
  return (
    <div className="text-center space-y-2">
      <h1 className="text-4xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent inline-flex items-center gap-3">
        <Music className="w-8 h-8 text-indigo-400" />
        TuneShift
      </h1>
      <p className="text-zinc-400">Turn any song into an instrumental masterpiece.</p>
    </div>
  );
}
