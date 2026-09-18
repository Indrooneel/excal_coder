import { useState } from 'react'

export default function MigGate({ plan, onApprove }) {
  const [constraints, setConstraints] = useState('')
  const isCmd = plan.tool === 'run_command'
  const preview = isCmd ? `$ ${plan.args.command ?? ''}` : (plan.args.content ?? '')

  return (
    <div className="self-center w-[92%] rounded-lg border border-red-500 bg-[#4d2c2c] p-3 shadow-lg shadow-red-950/50">
      <div className="mb-2 text-sm font-bold text-red-300">
        🛡️ MIG GATE: {isCmd ? 'Agent wants to RUN a command' : <>Agent wants to write to <span className="font-mono">"{plan.args.path}"</span></>}
      </div>
      <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-red-900 bg-black p-2 font-mono text-[11px] text-gray-300">{preview}</pre>
      <div className="mb-1 text-[11px] text-gray-300">What should the agent absolutely NOT do? (blank = plain approve)</div>
      <input
        className="mb-2 w-full rounded border border-[#555] bg-[#1e1e1e] px-2 py-1.5 text-xs text-white outline-none focus:border-red-400"
        placeholder="e.g. do not install packages, do not delete files…"
        value={constraints}
        onChange={(e) => setConstraints(e.target.value)}
      />
      <button
        className="w-full rounded bg-[#0e639c] py-2 text-sm font-bold text-white transition hover:bg-[#1177bb]"
        onClick={() => onApprove(constraints)}
      >
        Apply & Execute
      </button>
    </div>
  )
}