export default function Section({ step, title, children }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <span className="bg-indigo-500/20 text-indigo-400 w-8 h-8 rounded-full flex items-center justify-center text-sm">
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}
