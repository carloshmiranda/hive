#!/bin/bash
set -e

# ============================================================================
# 🐝 HIVE — One-Shot Setup Script
# Run this from the directory where you extracted hive-project.tar.gz
# Prerequisites: gh (GitHub CLI), vercel (Vercel CLI), node 20+
# ============================================================================

echo "🐝 Hive Setup"
echo "============================================"
echo ""

# --- Check prerequisites ---
echo "Checking prerequisites..."
command -v gh >/dev/null 2>&1 || { echo "❌ GitHub CLI (gh) not found. Install: brew install gh"; exit 1; }
command -v vercel >/dev/null 2>&1 || { echo "❌ Vercel CLI not found. Install: npm i -g vercel"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found. Install: brew install node"; exit 1; }
echo "✓ All prerequisites found"
echo ""

# --- Navigate to project ---
HIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$HIVE_DIR"
echo "Working in: $HIVE_DIR"
echo ""

# --- Step 1: GitHub repo ---
echo "Step 1/6: Creating GitHub repository..."
if gh repo view hive >/dev/null 2>&1; then
  echo "  ⓘ Repo 'hive' already exists, skipping creation"
else
  gh repo create hive --private --source=. --push --description "🐝 Hive — Venture Orchestrator"
  echo "  ✓ Repo created and pushed"
fi

# Make sure we're up to date
git add -A
git commit -m "Hive v0.1.0 — venture orchestrator" --allow-empty 2>/dev/null || true
git push origin main 2>/dev/null || git push -u origin main
echo ""

# --- Step 2: Generate secrets ---
echo "Step 2/6: Generating secrets..."
AUTH_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
CRON_SECRET=$(openssl rand -hex 16)

echo "  ✓ AUTH_SECRET generated"
echo "  ✓ ENCRYPTION_KEY generated"
echo "  ✓ CRON_SECRET generated"
echo ""

# --- Step 3: GitHub OAuth App ---
echo "Step 3/6: GitHub OAuth App setup"
echo ""
echo "  ⚠️  MANUAL STEP — open this URL in your browser:"
echo "  https://github.com/settings/applications/new"
echo ""
echo "  Fill in:"
echo "    Application name: Hive"
echo "    Homepage URL: https://hive-dashboard.vercel.app"
echo "    Callback URL: https://hive-dashboard.vercel.app/api/auth/callback/github"
echo ""
read -p "  Paste your Client ID: " GITHUB_OAUTH_ID
read -p "  Paste your Client Secret: " GITHUB_OAUTH_SECRET
echo ""

# Get GitHub user ID
GITHUB_USER_ID=$(gh api user --jq '.id')
GITHUB_USERNAME=$(gh api user --jq '.login')
echo "  ✓ GitHub user: $GITHUB_USERNAME (ID: $GITHUB_USER_ID)"
echo ""

# --- Step 4: Neon database ---
echo "Step 4/6: Neon database setup"
echo ""
echo "  ⚠️  MANUAL STEP — open this URL in your browser:"
echo "  https://console.neon.tech/app/projects"
echo ""
echo "  1. Click 'New Project'"
echo "  2. Name: hive"
echo "  3. Region: AWS eu-west-1 (Ireland — closest to Portugal)"
echo "  4. Copy the connection string"
echo ""
read -p "  Paste your Neon DATABASE_URL: " DATABASE_URL
echo ""

echo "  Running schema..."
psql "$DATABASE_URL" -f schema.sql 2>/dev/null && echo "  ✓ Schema created" || {
  echo "  ⚠️  psql not found or connection failed."
  echo "  Run this manually: psql \"\$DATABASE_URL\" -f schema.sql"
  echo "  Or paste the schema.sql contents into Neon's SQL Editor"
}
echo ""

# --- Step 5: Deploy to Vercel ---
echo "Step 5/6: Deploying to Vercel..."
echo ""

# Link and set env vars
vercel link --yes 2>/dev/null || true

echo "  Setting environment variables..."
echo "$DATABASE_URL" | vercel env add DATABASE_URL production preview --yes 2>/dev/null
echo "$AUTH_SECRET" | vercel env add AUTH_SECRET production preview --yes 2>/dev/null
echo "$GITHUB_OAUTH_ID" | vercel env add AUTH_GITHUB_ID production preview --yes 2>/dev/null
echo "$GITHUB_OAUTH_SECRET" | vercel env add AUTH_GITHUB_SECRET production preview --yes 2>/dev/null
echo "$GITHUB_USER_ID" | vercel env add ALLOWED_GITHUB_ID production preview --yes 2>/dev/null
echo "$ENCRYPTION_KEY" | vercel env add ENCRYPTION_KEY production preview --yes 2>/dev/null
echo "$CRON_SECRET" | vercel env add CRON_SECRET production preview --yes 2>/dev/null
echo "https://hive-dashboard.vercel.app" | vercel env add NEXT_PUBLIC_URL production preview --yes 2>/dev/null
echo "  ✓ Environment variables set"

echo "  Deploying..."
DEPLOY_URL=$(vercel deploy --prod 2>&1 | tail -1)
echo "  ✓ Deployed to: $DEPLOY_URL"
echo ""

# --- Step 6: Local config ---
echo "Step 6/6: Setting up local environment..."

cat > .env.local << EOF
DATABASE_URL=$DATABASE_URL
AUTH_SECRET=$AUTH_SECRET
AUTH_GITHUB_ID=$GITHUB_OAUTH_ID
AUTH_GITHUB_SECRET=$GITHUB_OAUTH_SECRET
ALLOWED_GITHUB_ID=$GITHUB_USER_ID
ENCRYPTION_KEY=$ENCRYPTION_KEY
CRON_SECRET=$CRON_SECRET
NEXT_PUBLIC_URL=http://localhost:3000
EOF
echo "  ✓ .env.local created"

echo ""

# --- Done ---
echo "============================================"
echo "🐝 Hive is deployed!"
echo "============================================"
echo ""
echo "Dashboard:  $DEPLOY_URL"
echo "Local dev:  npm run dev → http://localhost:3000"
echo ""
echo "Next steps:"
echo "  1. Open $DEPLOY_URL and sign in with GitHub"
echo "  2. Go to Settings and add your API keys:"
echo "     - Vercel token (vercel.com/account/tokens)"
echo "     - GitHub PAT (github.com/settings/tokens — scopes: repo, workflow)"
echo "     - Neon API key (console.neon.tech → Account → API Keys)"
echo "     - Stripe secret key (dashboard.stripe.com/apikeys)"
echo "     - Resend API key (resend.com/api-keys)"
echo "     - Your digest email address"
echo ""
echo "  3. Set up GitHub webhooks:"
echo "     gh api repos/$GITHUB_USERNAME/hive/hooks -f url=$DEPLOY_URL/api/webhooks/github -f content_type=json -f 'events[]=push' -f 'events[]=deployment_status' -f 'events[]=issues'"
echo ""
echo "  4. Set up GitHub Actions secrets:"
echo "     gh secret set CLAUDE_CODE_OAUTH_TOKEN --body '<your-token>'"
echo "     gh secret set GH_PAT --body '<your-pat>'"
echo "     gh secret set DATABASE_URL --body '$DATABASE_URL'"
echo ""
echo "Then open Claude Code in this directory and start building."
echo "============================================"
