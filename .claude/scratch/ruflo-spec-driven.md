# Ruflo Spec-Driven Development (pasted by Carlos)

Complex projects fail when implementation drifts from the original plan. Ruflo solves this with spec-first: define architecture through ADRs, organize code into DDD bounded contexts, enforce compliance as agents work.

## How It Prevents Drift
| Capability | What It Does |
|-----------|--------------|
| Spec-First Planning | Agents generate ADRs before writing code, capturing requirements and decisions |
| Real-Time Compliance | Statusline shows ADR compliance %, catches deviations immediately |
| Bounded Contexts | Each domain (Security, Memory, etc.) has clear boundaries agents can't cross |
| Validation Gates | hooks progress blocks merges that violate specifications |
| Living Documentation | ADRs update automatically as requirements evolve |

## Specification Features
| Feature | Description |
|---------|-------------|
| Architecture Decision Records | 10 ADRs defining system behavior, integration patterns, and security requirements |
| Domain-Driven Design | 5 bounded contexts with clean interfaces preventing cross-domain pollution |
| Automated Spec Generation | Agents create specs from requirements using SPARC methodology |
| Drift Detection | Continuous monitoring flags when code diverges from spec |
| Hierarchical Coordination | Queen agent enforces spec compliance across all worker agents |

## DDD Bounded Contexts
- Core: Agents, Swarms, Tasks
- Memory: AgentDB, HNSW, Cache
- Security: AIDefence, Validation, CVE Fixes
- Integration: agentic-flow, MCP
- Coordination: Consensus, Hive-Mind

## Key ADRs
- ADR-001: agentic-flow@alpha as foundation
- ADR-006: Unified Memory Service with AgentDB
- ADR-008: Vitest testing framework
- ADR-009: Hybrid Memory Backend (SQLite + HNSW)
- ADR-026: Intelligent 3-tier model routing
- ADR-048: Auto Memory Bridge (Claude Code ↔ AgentDB bidirectional sync)
- ADR-049: Self-Learning Memory with GNN
