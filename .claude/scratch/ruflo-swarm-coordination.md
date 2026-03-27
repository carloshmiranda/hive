# Ruflo Swarm Coordination (pasted by Carlos)

Agents organize into swarms led by queens that coordinate work, prevent drift, and reach consensus on decisions—even when some agents fail.

| Layer | Components | What It Does |
|-------|-----------|--------------|
| Coordination | Queen, Swarm, Consensus | Manages agent teams (Raft, Byzantine, Gossip) |
| Drift Control | Hierarchical topology, Checkpoints | Prevents agents from going off-task |
| Hive Mind | Queen-led hierarchy, Collective memory | Strategic/tactical/adaptive queens coordinate workers |
| Consensus | Byzantine, Weighted, Majority | Fault-tolerant decisions (2/3 majority for BFT) |

Hive Mind Capabilities:
- Queen Types: Strategic (planning), Tactical (execution), Adaptive (optimization)
- 8 Worker Types: Researcher, Coder, Analyst, Tester, Architect, Reviewer, Optimizer, Documenter
- 3 Consensus Algorithms: Majority, Weighted (Queen 3x), Byzantine (f < n/3)
- Collective Memory: Shared knowledge, LRU cache, SQLite persistence with WAL
- Performance: Fast batch spawning with parallel agent coordination
