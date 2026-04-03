#!/bin/bash
# Fires on SessionStart after compaction — re-injects critical state into context
# stdout from this script is added to Claude's context window

echo "CONTEXT INJECTION (post-compaction)"
echo "===================================="
echo ""
echo "IMPORTANT: Context was just compacted. Before continuing work:"
echo "1. If you made architecture/infrastructure changes this session, run /context NOW"
echo "2. If you haven't updated context files yet, do it before any new work"
echo ""
echo "Current state snapshot:"
head -100 "$CLAUDE_PROJECT_DIR/BRIEFING.md" 2>/dev/null || echo "(BRIEFING.md not found)"
echo ""
echo "---"
echo "Recent memory (infra):"
cat "$CLAUDE_PROJECT_DIR/../memory/project_infra.md" 2>/dev/null | head -40 || true
echo ""
echo "---"
echo "Recent memory (model routing):"
cat "$CLAUDE_PROJECT_DIR/../memory/project_model_routing.md" 2>/dev/null | head -30 || true

# Re-inject scratch files (user-pasted content saved before compaction)
SCRATCH_DIR="$CLAUDE_PROJECT_DIR/.claude/scratch"
if [ -d "$SCRATCH_DIR" ] && [ "$(ls -A "$SCRATCH_DIR" 2>/dev/null)" ]; then
  echo ""
  echo "---"
  echo "SCRATCH FILES (user-pasted content preserved across compaction):"
  for f in "$SCRATCH_DIR"/*; do
    if [ -f "$f" ]; then
      echo ""
      echo "=== $(basename "$f") ==="
      cat "$f"
    fi
  done
fi
