import { useEffect, useRef, useState, useCallback } from 'react'

const WS_URL = import.meta.env.VITE_WS_URL ||
  (window.location.port === '8000' ? `ws://${window.location.host}` : 'ws://localhost:8000')

export default function useExcalSocket() {
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState([])
  const [thinking, setThinking] = useState(false)
  const [pendingPlan, setPendingPlan] = useState(null)
  const [activeFile, setActiveFile] = useState(null)

  const push = (m) => setMessages(prev => [...prev, m])

  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      setThinking(false)
      if (msg.type === 'thinking') setThinking(true)
      else if (msg.type === 'tool_call')
        push({ kind: 'tool', text: `🛠️ ${msg.tool} ${JSON.stringify(msg.args).slice(0, 80)}${msg.constraints ? ` (constrained: ${msg.constraints})` : ''}` })
      else if (msg.type === 'tool_result') {
        push({ kind: msg.ok === false ? 'error' : 'tool', text: msg.ok === false ? String(msg.result) : '✅ ' + String(msg.result) }.text ? { kind: msg.ok === false ? 'error' : 'tool', text: msg.ok === false ? String(msg.result).slice(0, 200) : '✅ ' + String(msg.result).slice(0, 200) } : null)
        if (msg.file && msg.content !== undefined) setActiveFile({ path: msg.file, content: msg.content })
      }
      else if (msg.type === 'mig_verdict') push({ kind: 'verdict', text: `🛡️ MIG VERDICT: ${msg.verdict}` })
      else if (msg.type === 'final') push({ kind: 'ai', text: msg.content })
      else if (msg.type === 'error') push({ kind: 'error', text: `❌ ${msg.content}` })
      else if (msg.type === 'approval_needed') setPendingPlan(msg.plan)
    }
    return () => ws.close()
  }, [])

  const send = useCallback((text) => {
    push({ kind: 'user', text })
    setThinking(true)
    wsRef.current?.send(JSON.stringify({ type: 'chat', message: text }))
  }, [])

  const approve = useCallback((constraints) => {
    wsRef.current?.send(JSON.stringify({ type: 'approve', constraints }))
    setPendingPlan(null)
    setThinking(true)
  }, [])

  return { connected, messages, thinking, pendingPlan, activeFile, send, approve }
}