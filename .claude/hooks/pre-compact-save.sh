#!/bin/bash
# Fires BEFORE compaction — reminds Claude to save context before it's compressed
# stdout is injected into Claude's context

echo "BEFORE COMPACTION: Have you updated context files?"
echo ""
echo "If you changed architecture, workflows, or infrastructure this session,"
echo "you MUST update these files NOW (before compaction loses the details):"
echo "  - BRIEFING.md (Recent Context section)"
echo "  - DECISIONS.md (if architectural choices were made)"
echo "  - memory/project_infra.md (if infra changed)"
echo "  - Backlog DB via MCP (if items completed or discovered — NOT BACKLOG.md)"
echo "  - MISTAKES.md (if something broke)"
echo ""
echo "Run /context if unsure. Context drift causes wrong recommendations."
