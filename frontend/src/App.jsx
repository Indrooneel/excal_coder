import useExcalSocket from "./hooks/useExcalSocket";
import EditorPane from "./components/EditorPane";
import ChatPanel from "./components/ChatPanel";
import StatusBar from "./components/StatusBar";

export default function App() {
  // ✅ added `deny` to the destructure
  const { connected, messages, thinking, pendingPlan, activeFile, send, approve, deny } = useExcalSocket()

  return (
    <div className="flex h-screen flex-col bg-[#1e1e1e] text-white">
      <div className="flex flex-1 overflow-hidden">
        <div className="min-w-0 flex-[3] border-r border-[#333]">
          <EditorPane file={activeFile} />
        </div>
        <div className="w-[380px] shrink-0">
          {/* ✅ added onDeny={deny} */}
          <ChatPanel
            messages={messages}
            thinking={thinking}
            pendingPlan={pendingPlan}
            onSend={send}
            onApprove={approve}
            onDeny={deny}
          />
        </div>
      </div>
      <StatusBar connected={connected} />
    </div>
  )
}