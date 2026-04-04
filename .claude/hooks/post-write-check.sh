#!/bin/bash
# PostToolUse:Write hook — runs after every Write tool use
# Checks: console.log leaks, edge runtime import violations
# Advisory only — the file is already written

# Read hook input JSON from stdin
INPUT=$(cat)

# Extract file path from tool input
FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('file_path', ''))
except:
    print('')
" 2>/dev/null)

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Only check TypeScript/TSX files
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.tsx ]]; then
  exit 0
fi

WARNINGS=()
ERRORS=()

# ── 1. console.log check ──────────────────────────────────────────────────────
# console.log is noise in production logs. Use console.warn for structured output.
if grep -qn "console\.log(" "$FILE_PATH" 2>/dev/null; then
  SNIPPET=$(grep -n "console\.log(" "$FILE_PATH" | head -3 | sed 's/^/    /')
  WARNINGS+=("console.log found — use console.warn for structured logging:\n$SNIPPET")
fi

# ── 2. Edge runtime import check ─────────────────────────────────────────────
# Node.js-only APIs cannot run in Vercel Edge Runtime (middleware, /edge/ routes)
IS_EDGE=false
if [[ "$FILE_PATH" == */middleware.ts ]] || \
   [[ "$FILE_PATH" == */middleware.tsx ]] || \
   [[ "$FILE_PATH" =~ /route\.(ts|tsx)$ ]] && grep -q "runtime.*=.*['\"]edge['\"]" "$FILE_PATH" 2>/dev/null; then
  IS_EDGE=true
fi
# Also check files that explicitly declare edge runtime
if grep -q "export const runtime = ['\"]edge['\"]" "$FILE_PATH" 2>/dev/null; then
  IS_EDGE=true
fi

if [ "$IS_EDGE" = true ]; then
  NODE_ONLY_MODULES=("node:fs" "node:path" "node:os" "node:child_process" "node:crypto" "node:stream" "node:http" "node:https" "node:net" "node:tls" "node:dns" "node:cluster" "node:worker_threads" "\"fs\"" "\"path\"" "\"os\"" "\"child_process\"" "\"crypto\"" "\"stream\"" "\"http\"" "\"https\"" "\"net\"" "\"tls\"")
  for MOD in "${NODE_ONLY_MODULES[@]}"; do
    CLEAN_MOD="${MOD//\"/}"
    if grep -q "from $MOD" "$FILE_PATH" 2>/dev/null || grep -q "require($MOD)" "$FILE_PATH" 2>/dev/null; then
      ERRORS+=("🚫 EDGE VIOLATION: '$CLEAN_MOD' imported in edge file $FILE_PATH — will fail at runtime")
    fi
  done
fi

# ── Output ────────────────────────────────────────────────────────────────────
if [ ${#ERRORS[@]} -gt 0 ] || [ ${#WARNINGS[@]} -gt 0 ]; then
  echo ""
  echo "┌─ Post-Write Check: $(basename $FILE_PATH) ──────────────────────────────"

  for E in "${ERRORS[@]}"; do
    printf "│ %b\n" "$E"
  done

  for W in "${WARNINGS[@]}"; do
    printf "│ ⚠️  %b\n" "$W"
  done

  if [ ${#ERRORS[@]} -gt 0 ]; then
    echo "│"
    echo "│ Fix edge violations before deploying — Vercel will reject the build."
  fi

  echo "└────────────────────────────────────────────────────────────────"
  echo ""
fi

exit 0
