# Ruflo Anti-Drift + Claude Code Comparison Table (pasted by Carlos)

## Anti-Drift Swarm Configuration
Prevent goal drift in multi-agent work

## Claude Code: With vs Without Ruflo

| Capability | Claude Code Alone | Claude Code + Ruflo |
|-----------|------------------|-------------------|
| Agent Collaboration | Agents work in isolation, no shared context | Agents collaborate via swarms with shared memory and consensus |
| Coordination | Manual orchestration between tasks | Queen-led hierarchy with 5 consensus algorithms (Raft, Byzantine, Gossip) |
| Hive Mind | Not available | Queen-led swarms with collective intelligence, 3 queen types, 8 worker types |
| Consensus | No multi-agent decisions | Byzantine fault-tolerant voting (f < n/3), weighted, majority |
| Memory | Session-only, no persistence | HNSW vector memory with sub-ms retrieval + knowledge graph |
| Vector Database | No native support | RuVector PostgreSQL with 77+ SQL functions, ~61µs search, 16,400 QPS |
| Knowledge Graph | Flat insight lists | PageRank + community detection identifies influential insights (ADR-049) |
| Collective Memory | No shared knowledge | Shared knowledge base with LRU cache, SQLite persistence, 8 memory types |
| Learning | Static behavior, no adaptation | SONA self-learning with <0.05ms adaptation, LearningBridge for insights |
| Agent Scoping | Single project scope | 3-scope agent memory (project/local/user) with cross-agent transfer |
| Task Routing | You decide which agent to use | Intelligent routing based on learned patterns (89% accuracy) |
| Complex Tasks | Manual breakdown required | Automatic decomposition across 5 domains (Security, Core, Integration, Support) |
| Background Workers | Nothing runs automatically | 12 context-triggered workers auto-dispatch on file changes, patterns, sessions |
| LLM Provider | Anthropic only | 6 providers with automatic failover and cost-based routing (85% savings) |
| Security | Standard protections | CVE-hardened with bcrypt, input validation, path traversal prevention |
| Performance | Baseline | Faster tasks via parallel swarm spawning and intelligent routing |
