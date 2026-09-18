import Editor from '@monaco-editor/react'

const LANGS = { py: 'python', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', html: 'html', css: 'css', json: 'json', md: 'markdown', txt: 'plaintext' }

export default function EditorPane({ file }) {
  const ext = file?.path?.split('.').pop()?.toLowerCase() || 'txt'
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[#333] bg-[#2d2d2d] px-4 py-2 text-xs text-gray-300">
        <span>📄</span><span className="font-mono">{file?.path ?? '(no file open)'}</span>
      </div>
      <Editor
        height="100%"
        theme="vs-dark"
        language={LANGS[ext] || 'plaintext'}
        value={file?.content ?? '// Excal Coder\n// Ask the agent to read or create a file.\n'}
        options={{ fontSize: 14, minimap: { enabled: false }, automaticLayout: true }}
      />
    </div>
  )
}