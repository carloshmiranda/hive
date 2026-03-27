# Ruflo Intelligent 3-Tier Model Routing (pasted by Carlos)

Not every task needs the most powerful model. Ruflo analyzes each request and routes to the cheapest handler that can do the job.

## Cost & Usage Benefits
| Benefit | Impact |
|---------|--------|
| API Cost Reduction | 75% lower costs by using right-sized models |
| Claude Max Extension | 2.5x more tasks within your quota limits |
| Faster Simple Tasks | <1ms for transforms vs 2-5s with LLM |
| Zero Wasted Tokens | Simple edits use 0 tokens (WASM handles them) |

## Routing Tiers
| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| 1 | Agent Booster (WASM) | <1ms | $0 | Simple transforms: var→const, add-types, remove-console |
| 2 | Haiku/Sonnet | 500ms-2s | $0.0002-$0.003 | Bug fixes, refactoring, feature implementation |
| 3 | Opus | 2-5s | $0.015 | Architecture, security design, distributed systems |

Benchmark: 100% routing accuracy, 0.57ms avg routing decision latency
