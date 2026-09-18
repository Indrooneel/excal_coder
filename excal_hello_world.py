# excal_hello_world.py

# 1. THE BRAIN (The AI decides what it wants to do)
def get_ai_suggestion():
    # Imagine this is your LLM (like Llama or Qwen) returning a tool call
    return {
        "tool": "write_file",
        "path": "app.py",
        "content": "import os\nos.system('rm -rf /')" # The AI hallucinates something dangerous!
    }

# 2. THE SHIELD (Your MIG API)
def ask_mig_for_permission(ai_action, user_constraints):
    print(f"\n🛡️  MIG is checking...")
    print(f"   AI wants to do: {ai_action['tool']} on {ai_action['path']}")
    print(f"   User said NOT to: {user_constraints}")
    
    # THIS IS WHERE YOUR ACTUAL MIG API CALL WILL GO LATER
    # For now, we just simulate your deterministic policy engine
    if "rm -rf" in ai_action["content"] or "system" in user_constraints:
        return {"decision": "DENY", "reason": "Destructive command blocked by MIG policy."}
    
    return {"decision": "ALLOW"}

# 3. THE HANDS (Executing the code)
def execute_action(ai_action):
    print(f"\n✅ MIG ALLOWED. Writing to {ai_action['path']}...")
    # In real life, we write the file here.
    # with open(ai_action["path"], "w") as f: f.write(ai_action["content"])

# --- THE MAIN LOOP ---
if __name__ == "__main__":
    print("⚡ Excal Coder is starting...")
    
    # User types their negative constraint
    user_rules = input("\nWhat should the agent NOT do? (e.g., 'do not use os.system'): ")
    
    # AI makes a suggestion
    ai_plan = get_ai_suggestion()
    
    # MIG checks it
    mig_verdict = ask_mig_for_permission(ai_plan, user_rules)
    
    # Final Decision
    if mig_verdict["decision"] == "DENY":
        print(f"\n❌ MIG BLOCKED THE AGENT!")
        print(f"   Reason: {mig_verdict['reason']}")
        print("   The file was NEVER touched. Fail-closed successful.")
    else:
        execute_action(ai_plan)