import { useEffect, useRef, useState } from 'react'
import MigGate from './MigGate.jsx'

const STYLES = {
  user: 'self-end bg-[#0e639c] rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap',
  ai: 'self-start bg-[#3c3c3c] rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap',
  tool: 'self-center text-[11px] italic text-gray-400 bg-[#2d2d2d] rounded px-2 py-1 max-w-[90%]',
  verdict: 'self-center text-[11px] font-semibold text-sky-300 bg-[#1c2733] border border-sky-800 rounded px-2 py-1',
  error: 'self-center text-[11px] text-red-300 bg-[#331c1c] border border-red-900 rounded px-2 py-1 max-w-[90%]',
}

export default function ChatPanel({ messages, thinking, pendingPlan, onSend, onApprove }) {
  const [input, setInput] = useState('')
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, thinking, pendingPlan])

  const submit = () => { if (!input.trim()) return; onSend(input.trim()); setInput('') }

  return (
    <div className="flex h-full flex-col bg-[#252526]">
      <div className="border-b border-[#444] bg-[#333] px-4 py-3 font-bold">⚡ Excal Coder</div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4 text-sm">
        {messages.map((m, i) => <div key={i} className={STYLES[m.kind]}>{m.text}</div>)}
        {pendingPlan && <MigGate plan={pendingPlan} onApprove={onApprove} />}
        {thinking && <div className="self-center animate-pulse text-xs italic text-sky-300">🧠 Excal is thinking…</div>}
        <div ref={endRef} />
      </div>
      <div className="border-t border-[#444] p-3">
        <input
          className="w-full rounded border border-[#555] bg-[#3c3c3c] px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
          placeholder="Ask Excal… (Enter to send)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
    </div>
  )
}