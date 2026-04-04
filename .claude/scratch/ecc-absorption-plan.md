# Everything-Claude-Code Absorption Plan

**Source:** https://github.com/affaan-m/everything-claude-code
**Date:** 2026-04-04
**Status:** Phase A complete — Phase B complete — Phase C next

## Phase A (DONE): Hook Enforcement + Model Matrix + Build Error Rule + Docs-Lookup
- [x] PostToolUse:Write hook (console.log check, edge runtime check) — `.claude/hooks/post-write-check.sh`
- [x] Stop hook (context reminder) — `.claude/hooks/session-stop-reminder.sh`
- [x] Hooks registered in `.claude/settings.json`
- [x] CLAUDE.md: model selection matrix
- [x] CLAUDE.md: docs-lookup rule
- [x] CLAUDE.md: build error minimal intervention rule
- [x] .claude/skills/ts-guard/SKILL.md

## Phase B (DONE): TypeScript Reviewer + Security Reviewer + Context Injection
- [x] .claude/skills/ts-review/SKILL.md
- [x] .claude/skills/security-scan/SKILL.md
- [x] Context split: dev.md, research.md, review.md carved from CLAUDE.md
- [x] Update /do SKILL.md: Phase 3a (TS review) + Phase 3b (security check)

## Phase C: Growth/SEO Skills + TDD for Critical Paths
- [ ] Growth agent prompt: SEO audit, content brief, CRO checklist, email copy review
- [ ] Engineer prompt: test-first for auth/payments/dispatch

## Phase D (future): Loop-Operator + Performance Optimizer + Continuous Learning
- [ ] Design schema for continuous learning
- [ ] Loop-operator skill for interactive sessions
- [ ] Performance optimizer for front-end changes

---

## Key Principles (both lenses)

### Autonomous Agent Quality
- TypeScript/App Router reviewer in /do Phase 3
- Security scan in /do Phase 4
- Docs-lookup before any SDK method usage
- Build error minimal intervention (scope < 5% of file)
- SEO/content skills injected into Growth agent

### Interactive Session Quality  
- PostToolUse hooks enforce checklists physically (LLM can't skip)
- Stop hook triggers /context reminder
- Model matrix: Haiku for exploration, Sonnet for coding, Opus for architecture
- ts-guard skill for on-demand TypeScript/edge runtime audit
- security-scan skill for on-demand security review
