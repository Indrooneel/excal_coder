export default function StatusBar({ connected }) {
  return (
    <div className="flex items-center gap-3 bg-[#007acc] px-4 py-1 text-[11px] text-white">
      <span>MIG: stub + rules</span><span>·</span>
      <span>Model: openrouter/free</span><span>·</span>
      <span>{connected ? '● CONNECTED' : '○ DISCONNECTED'}</span>
      <span className="ml-auto font-semibold">Excal Coder v0.4 · House of Galatine</span>
    </div>
  )
}