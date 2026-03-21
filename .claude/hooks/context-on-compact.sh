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
head -60 "$CLAUDE_PROJECT_DIR/BRIEFING.md" 2>/dev/null || echo "(BRIEFING.md not found)"
echo ""
echo "---"
echo "Recent memory:"
cat "$CLAUDE_PROJECT_DIR/../memory/project_infra.md" 2>/dev/null | head -30 || true
