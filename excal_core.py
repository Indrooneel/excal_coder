import os
import json
from openai import OpenAI

# ==========================================
# 1. THE SHIELD (MIG STUB)
# ==========================================
def check_mig(tool_name, args):
    print(f"🛡️  MIG CHECK: Agent wants to run '{tool_name}' on {args.get('path', args.get('directory', 'system'))}")
    # Real MIG API call goes here later
    return True 

# ==========================================
# 2. THE BRAIN & HANDS
# ==========================================
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key="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",
    default_headers={
        'HTTP-Referer': 'https://excalcoder.ai', 
        'X-Title': 'Excal Coder',
    }
)

# The Agent's Memory
messages = [
    {
        "role": "system",
        "content": """You are Excal Coder, a governed AI coding assistant.
You have access to the following tools:
1. write_file(path, content) - Overwrites a file with new content.
2. read_file(path) - Reads the text content of an existing file.
3. list_files(directory) - Lists all files and folders in the specified directory. Use '.' for the current directory.

RULES:
- If you need to use a tool to accomplish the user's goal, respond ONLY with a JSON object: {"tool": "tool_name", "args": {"param1": "value1"}}
- If you are done, or just chatting, respond with normal conversational text.
- ALWAYS use list_files if you are not sure what files exist in the workspace.
"""
    }
]

def execute_tool(tool_call_json):
    tool = tool_call_json.get("tool")
    args = tool_call_json.get("args", {})
    
    # --- MIG GATE ---
    if not check_mig(tool, args):
        return "ERROR: Blocked by MIG policy."

    # --- EXECUTION ---
    try:
        if tool == "write_file":
            with open(args["path"], "w", encoding="utf-8") as f:
                f.write(args["content"])
            return f"SUCCESS: Wrote {len(args['content'])} characters to {args['path']}"
            
        elif tool == "read_file":
            with open(args["path"], "r", encoding="utf-8") as f:
                return f.read()
                
        elif tool == "list_files":
            directory = args.get("directory", ".")
            files = []
            
            # Folders we want to ignore so the agent doesn't get overwhelmed
            ignored_folders = {'myenv', 'node_modules', '__pycache__', '.git', '.vscode'}
            
            for item in os.listdir(directory):
                if item.startswith('.') or item in ignored_folders:
                    continue
                    
                path = os.path.join(directory, item)
                if os.path.isfile(path):
                    files.append(f"📄 {item}")
                elif os.path.isdir(path):
                    files.append(f"📁 {item}/")
                    
            return "\n".join(files) if files else "No files found in this directory."
                
        return "ERROR: Unknown tool."
    except Exception as e:
        return f"ERROR: {str(e)}"


# ==========================================
# 3. THE INTERACTIVE LOOP
# ==========================================
if __name__ == "__main__":
    print("⚡ Excal Coder v0.3 Online (Workspace Awareness)")
    print("Type 'exit' to quit.\n")
    
    while True:
        user_input = input("\nYou: ")
        if user_input.lower() in ['exit', 'quit']:
            break
            
        messages.append({"role": "user", "content": user_input})
        
        while True:
            response = client.chat.completions.create(
                model="openrouter/free",
                messages=messages
            )
            reply = response.choices[0].message.content
            
            try:
                clean_reply = reply.strip("```json\n").strip("\n```").strip("```")
                plan = json.loads(clean_reply)
                
                if "tool" in plan:
                    print(f"\n🛠️  Agent action: {plan['tool']}({plan.get('args', {})})")
                    
                    tool_result = execute_tool(plan)
                    print(f"✅ Result: {tool_result[:150]}... (truncated for display)")
                    
                    messages.append({"role": "assistant", "content": reply})
                    messages.append({"role": "user", "content": f"Tool execution result: {tool_result}"})
                    
            except json.JSONDecodeError:
                print(f"\n🤖 Excal: {reply}")
                messages.append({"role": "assistant", "content": reply})
                break