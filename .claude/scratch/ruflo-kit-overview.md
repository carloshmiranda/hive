# Ruflo Kit Overview + Token Optimizer API (pasted by Carlos)

## Kit sections:
1. Core Flow — How requests move through the system
2. Swarm Coordination — How agents work together
3. Intelligence & Memory — How the system learns and remembers
4. Optimization — How to reduce cost and latency
5. Operations — Background services and integrations
6. Task Routing — Extend your Claude Code subscription by 250%
7. Agent Booster (WASM) — Skip LLM for simple code transforms
8. Token Optimizer — 30-50% token reduction

## Token Optimizer API:
```typescript
import { getTokenOptimizer } from '@claude-flow/integration';
const optimizer = await getTokenOptimizer();

// Get compact context (32% fewer tokens)
const ctx = await optimizer.getCompactContext("auth patterns");

// Optimized edit (352x faster for simple transforms)
await optimizer.optimizedEdit(file, oldStr, newStr, "typescript");

// Optimal config for swarm (100% success rate)
const config = optimizer.getOptimalConfig(agentCount);
```
