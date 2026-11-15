// How a hook tells the host "no". Claude Code and Codex share the hook protocol but not every detail:
//
//   Claude Code: exit 2 with the reason on stderr blocks PreToolUse, PostToolUse and Stop.
//   Codex:       exit 2 is reported as a *failed* hook and the call goes ahead (seen on codex-cli 0.167 for
//                both apply_patch and shell). A JSON decision on stdout with exit 0 is what blocks:
//                  PreToolUse  -> {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}
//                  PostToolUse -> {"decision":"block","reason":...}  (replaces the tool result with the reason)
//                  Stop        -> {"decision":"block","reason":...}  (the reason becomes the continuation prompt)
//
// Claude Code always sets CLAUDE_PROJECT_DIR for hooks; Codex does not, and Codex payloads carry turn_id.
// Claude Code also understands the JSON form, so anything that isn't clearly Claude Code gets JSON.
export function isClaudeCode(input) {
  if (process.env.TAMPERPROOF_HOST) return process.env.TAMPERPROOF_HOST === "claude";
  return Boolean(process.env.CLAUDE_PROJECT_DIR) && input.turn_id === undefined;
}

// Tell the agent something without blocking (both hosts read additionalContext from hookSpecificOutput), and exit.
export function note(input, event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text.trim() } }) + "\n");
  process.exit(0);
}

// Block the current event with `reason` and exit. Claude Code's PostToolUseFailure takes exit 2 + stderr
// the same way PostToolUse does (the tool already ran; the reason is shown to the agent).
export function refuse(input, event, reason) {
  if (isClaudeCode(input)) {
    process.stderr.write(reason);
    process.exit(2);
  }
  const out = event === "PreToolUse"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.trim() } }
    : { decision: "block", reason: reason.trim() };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}
