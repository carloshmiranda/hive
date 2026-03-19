#!/bin/bash
set -euo pipefail

# ============================================================================
# Set CRON_SECRET in both Vercel and GitHub Actions
# Run from the hive repo directory on your Mac
# Requires: VERCEL_TOKEN env var or vercel_token in Hive settings
# ============================================================================

HIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ID="prj_n9JaPbWmRv0SKoHgkdXYOEGQtjRv"
TEAM_ID="team_Z4AsGtjfy6pAjCOtvJqzMT8d"
GITHUB_REPO="carloshmiranda/hive"

# --- Generate secret ---
CRON_SECRET=$(openssl rand -hex 32)
echo "Generated CRON_SECRET: ${CRON_SECRET:0:8}...${CRON_SECRET: -8}"
echo ""

# --- 1. Set in Vercel ---
echo "Setting CRON_SECRET in Vercel..."

# Get Vercel token from env or from .env.local
VERCEL_TOKEN="${VERCEL_TOKEN:-}"
if [ -z "$VERCEL_TOKEN" ]; then
  # Try to read from Vercel CLI config
  VERCEL_TOKEN=$(cat ~/.config/vercel/auth.json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
fi
if [ -z "$VERCEL_TOKEN" ]; then
  echo "  ⚠ No VERCEL_TOKEN found. Trying vercel CLI..."
  # Fall back to vercel env add
  if command -v vercel >/dev/null 2>&1; then
    echo "$CRON_SECRET" | vercel env add CRON_SECRET production preview --yes 2>/dev/null && echo "  ✓ Set via vercel CLI" || {
      echo "  ✗ vercel CLI failed. Set VERCEL_TOKEN env var and retry."
      echo "    Get your token from: https://vercel.com/account/tokens"
      exit 1
    }
  else
    echo "  ✗ Neither VERCEL_TOKEN nor vercel CLI available."
    exit 1
  fi
else
  # Use REST API
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "https://api.vercel.com/v10/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}" \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"key\": \"CRON_SECRET\",
      \"value\": \"${CRON_SECRET}\",
      \"type\": \"encrypted\",
      \"target\": [\"production\", \"preview\"]
    }")
  
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)
  
  if [ "$HTTP_CODE" -lt 300 ]; then
    echo "  ✓ CRON_SECRET set in Vercel (production + preview)"
  elif echo "$BODY" | grep -q "already exist"; then
    echo "  ⚠ CRON_SECRET already exists in Vercel — updating..."
    # Get existing env var ID
    ENV_ID=$(curl -s \
      "https://api.vercel.com/v9/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}" \
      -H "Authorization: Bearer ${VERCEL_TOKEN}" \
      | python3 -c "import json,sys; envs=json.load(sys.stdin).get('envs',[]); print(next((e['id'] for e in envs if e['key']=='CRON_SECRET'),''))" 2>/dev/null || echo "")
    
    if [ -n "$ENV_ID" ]; then
      curl -s -X PATCH \
        "https://api.vercel.com/v9/projects/${PROJECT_ID}/env/${ENV_ID}?teamId=${TEAM_ID}" \
        -H "Authorization: Bearer ${VERCEL_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"value\": \"${CRON_SECRET}\"}" >/dev/null
      echo "  ✓ CRON_SECRET updated in Vercel"
    else
      echo "  ✗ Could not find existing CRON_SECRET to update"
      exit 1
    fi
  else
    echo "  ✗ Vercel API error (HTTP $HTTP_CODE): $BODY"
    exit 1
  fi
fi
echo ""

# --- 2. Set in GitHub Actions ---
echo "Setting CRON_SECRET in GitHub Actions..."

# Get GitHub token
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$GITHUB_TOKEN" ]; then
  # Try gh CLI
  GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "")
fi
if [ -z "$GITHUB_TOKEN" ]; then
  echo "  ✗ No GitHub token. Run 'gh auth login' or set GITHUB_TOKEN."
  exit 1
fi

# GitHub Actions secrets require NaCl encryption with the repo's public key
# Step 1: Get the repo public key
PUB_KEY_RESPONSE=$(curl -s \
  "https://api.github.com/repos/${GITHUB_REPO}/actions/secrets/public-key" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json")

KEY_ID=$(echo "$PUB_KEY_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('key_id',''))")
PUB_KEY=$(echo "$PUB_KEY_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('key',''))")

if [ -z "$KEY_ID" ] || [ -z "$PUB_KEY" ]; then
  echo "  ✗ Could not get repo public key. Check GitHub token permissions (needs 'repo' scope)."
  echo "  Response: $PUB_KEY_RESPONSE"
  exit 1
fi

# Step 2: Encrypt the secret using Python (PyNaCl or pynacl)
ENCRYPTED=$(python3 -c "
import base64
try:
    from nacl import encoding, public
    pub_key = public.PublicKey(base64.b64decode('${PUB_KEY}'))
    sealed = public.SealedBox(pub_key).encrypt(b'${CRON_SECRET}')
    print(base64.b64encode(sealed).decode())
except ImportError:
    # Fallback: try tweetnacl via subprocess
    import subprocess, json
    result = subprocess.run(
        ['node', '-e', '''
const crypto = require('crypto');
const nacl = require('tweetnacl');
nacl.util = require('tweetnacl-util');
const key = Buffer.from('${PUB_KEY}', 'base64');
const msg = Buffer.from('${CRON_SECRET}');
const encrypted = nacl.box.seal(msg, key);
console.log(Buffer.from(encrypted).toString('base64'));
        '''],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(result.stdout.strip())
    else:
        # Last resort: use gh CLI
        print('USE_GH_CLI')
" 2>/dev/null || echo "USE_GH_CLI")

if [ "$ENCRYPTED" = "USE_GH_CLI" ] || [ -z "$ENCRYPTED" ]; then
  # Fallback to gh CLI which handles encryption internally
  if command -v gh >/dev/null 2>&1; then
    echo "$CRON_SECRET" | gh secret set CRON_SECRET --repo "${GITHUB_REPO}" 2>/dev/null
    if [ $? -eq 0 ]; then
      echo "  ✓ CRON_SECRET set in GitHub Actions (via gh CLI)"
    else
      echo "  ✗ gh secret set failed"
      exit 1
    fi
  else
    echo "  ✗ Cannot encrypt secret (need PyNaCl, tweetnacl, or gh CLI)"
    echo "  Install: pip3 install pynacl OR brew install gh"
    exit 1
  fi
else
  # Step 3: Set the secret via API
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X PUT "https://api.github.com/repos/${GITHUB_REPO}/actions/secrets/CRON_SECRET" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    -d "{
      \"encrypted_value\": \"${ENCRYPTED}\",
      \"key_id\": \"${KEY_ID}\"
    }")
  
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  
  if [ "$HTTP_CODE" -lt 300 ]; then
    echo "  ✓ CRON_SECRET set in GitHub Actions (via API)"
  else
    BODY=$(echo "$RESPONSE" | head -n -1)
    echo "  ✗ GitHub API error (HTTP $HTTP_CODE): $BODY"
    # Fallback to gh CLI
    if command -v gh >/dev/null 2>&1; then
      echo "  Trying gh CLI fallback..."
      echo "$CRON_SECRET" | gh secret set CRON_SECRET --repo "${GITHUB_REPO}"
      echo "  ✓ CRON_SECRET set via gh CLI"
    else
      exit 1
    fi
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ CRON_SECRET set in both Vercel and GitHub"
echo ""
echo "Test it:"
echo "  curl -s https://hive-phi.vercel.app/api/agents/dispatch \\"
echo "    -X POST \\"
echo "    -H 'Authorization: Bearer ${CRON_SECRET}' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"company_slug\":\"verdedesk\",\"agent\":\"ops\",\"trigger\":\"test\"}' | jq ."
echo ""
echo "Note: Vercel needs a redeploy to pick up the new env var."
echo "Either push new code or run: vercel --prod"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
