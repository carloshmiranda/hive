#!/bin/bash
# Stop hook — runs when Claude Code session ends
# Reminds to run /context if changes were made this session

# Check for uncommitted or staged changes
HAS_STAGED=$(git diff --cached --name-only 2>/dev/null | head -1)
HAS_UNSTAGED=$(git diff --name-only 2>/dev/null | head -1)
HAS_UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | head -1)

if [ -n "$HAS_STAGED" ] || [ -n "$HAS_UNSTAGED" ] || [ -n "$HAS_UNTRACKED" ]; then
  echo ""
  echo "┌─ Session End ───────────────────────────────────────────────────"
  echo "│ 📸 Uncommitted changes detected. Before closing:"
  echo "│"
  echo "│   Run /context to:"
  echo "│   • Sync BRIEFING.md + memory files with this session's work"
  echo "│   • Mark completed backlog items as done in the DB"
  echo "│   • Prevent context drift for the next session"
  echo "│"
  echo "│   Skipping /context = next session inherits stale state."
  echo "└─────────────────────────────────────────────────────────────────"
  echo ""
  exit 0
fi

# Check for recent commits not yet pushed
UNPUSHED=$(git log @{u}..HEAD --oneline 2>/dev/null | head -1)
if [ -n "$UNPUSHED" ]; then
  echo ""
  echo "┌─ Session End ───────────────────────────────────────────────────"
  echo "│ 🚀 Unpushed commits detected. Remember to push when ready."
  echo "│   Run /context if BRIEFING.md hasn't been updated this session."
  echo "└─────────────────────────────────────────────────────────────────"
  echo ""
fi

exit 0
