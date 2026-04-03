---
name: memory-systems
description: This skill should be used when the user asks about agent memory, session persistence, or how to make agents remember things across conversations. Also use when the user mentions memory frameworks (Mem0, Zep, Letta, LangMem, Cognee), knowledge graphs, entity tracking, temporal facts, long-term memory, episodic memory, semantic memory, memory retrieval strategies, or when asking why an agent keeps forgetting context or making the same mistakes repeatedly.
metadata:
  version: 4.0.0
---

# Memory Systems for AI Agents

Agents without memory repeat mistakes, lose context, and cannot improve. Agents with poorly designed memory hallucinate facts, retrieve irrelevant context, and slow down. This skill covers production memory system design and framework selection.

## When to Activate

Activate this skill when:
- An agent forgets established facts or decisions from previous sessions
- You need to choose between memory frameworks (Mem0, Zep, Letta, LangMem, etc.)
- Designing entity tracking, user preference storage, or knowledge accumulation
- Agent context windows are filling with repeated background information
- Building a system that needs to improve over time from accumulated interactions

## Memory Layer Architecture

Most production systems need multiple memory layers. Choose based on the temporal and structural properties of what you're storing:

| Memory Type | What It Stores | Typical TTL | Best Implementation |
|-------------|---------------|-------------|---------------------|
| **Working memory** | Current task state, scratch | Session only | In-context variables |
| **Short-term memory** | Recent interactions, summaries | Hours to days | Redis with TTL |
| **Long-term memory** | Facts, preferences, learnings | Indefinite | Vector DB + graph |
| **Entity memory** | People, companies, projects | Indefinite | Knowledge graph |
| **Temporal KG** | Facts with validity intervals | Indefinite | Zep/Graphiti pattern |
| **Procedural memory** | How to do things | Indefinite | Skill files / prompts |

Don't build one store for everything. A hybrid approach — Redis for fast recent access, vector DB for semantic search, graph for relationships — outperforms any single store.

## Framework Landscape (Production)

### Mem0
**Architecture:** Layered memory with automatic extraction and retrieval. Extracts entities, relationships, and facts from conversations, stores in a graph + vector index, retrieves relevant context automatically.

**Best for:** SaaS products that need user-level personalization with minimal infrastructure. Managed cloud or self-hosted.

**Benchmarks:** Leads on LOCOMO benchmark (long conversation memory). DMR (declarative memory reasoning) score ~0.85+. Trade-off: managed service, less control over extraction logic.

**Free tier:** 100K memories on cloud. Self-hostable with Qdrant + Neo4j.

### Zep / Graphiti
**Architecture:** Temporal knowledge graph. Every fact stored with validity intervals (`valid_from`, `valid_until`). When a fact changes ("Alice works at Google" → "Alice works at Meta"), old fact is invalidated, new one created — history preserved.

**Best for:** Systems where facts change over time and you need to ask "what did we know as of date X?" Essential for any agent managing evolving business/customer state.

**Key pattern:**
```python
# Facts with temporal validity
graph.add_edge(
    source="alice",
    relation="works_at",
    target="meta",
    valid_from="2024-03-01",
    valid_until=None  # current
)
```

**Benchmarks:** Best-in-class for temporal reasoning and contradiction resolution. Excellent for entities that change over time.

### Letta (formerly MemGPT)
**Architecture:** OS-inspired memory management. Main context (in-window), external storage (archival + recall), and explicit memory management functions agents call to page content in/out. Agent decides what to remember.

**Best for:** Long-running autonomous agents that need to manage their own memory. Agents that must handle unbounded conversation history.

**Trade-off:** Higher complexity. Agent must learn when to archive/recall. Good for single-user long-running assistants; overkill for multi-user SaaS.

### LangMem (LangChain)
**Architecture:** Integrates with LangGraph. Memory store with namespaced keys. Supports semantic search and structured storage. Tight integration with LangGraph agent primitives.

**Best for:** Systems already on LangGraph/LangChain stack. Provides reasonable default behavior with minimal configuration.

**Trade-off:** Framework lock-in. Harder to use outside LangChain ecosystem.

### Cognee
**Architecture:** Knowledge graph generation from documents + conversations using LLM-extracted entities and relationships. Strong focus on graph-based reasoning over stored knowledge.

**Best for:** Document-heavy systems where the agent needs to reason over large knowledge bases, not just retrieve facts.

**Trade-off:** Heavier LLM usage for ingestion (extracts graph from text). Best when documents are the primary memory source.

### Filesystem (Custom)
**Architecture:** Files as memory, structured by scope and topic. No framework dependency.

**Best for:** Simple agent systems, development environments, systems where you need full control. See `filesystem-context` skill for patterns.

**Trade-off:** Manual retrieval logic required. Doesn't scale to millions of facts.

## Framework Selection Decision Tree

```
Does memory need to survive session end?
├── No → In-context variables (no external system needed)
└── Yes → Does it involve temporal facts (things that change)?
    ├── Yes → Zep/Graphiti (temporal knowledge graph)
    └── No → Is it entity-centric (users, companies, objects)?
        ├── Yes → Mem0 (managed) or Neo4j (self-hosted graph)
        └── No → Is it document/knowledge-based?
            ├── Yes → Cognee or pgvector with chunking
            └── No → Are you on LangGraph?
                ├── Yes → LangMem
                └── No → Redis + simple vector store or filesystem
```

## Memory Benchmarks

Three standard benchmarks to compare systems:

| Benchmark | What It Measures | Leader | Notes |
|-----------|-----------------|--------|-------|
| **DMR** (Declarative Memory Reasoning) | Factual accuracy from memory | Mem0 / Zep | Tests if stored facts can be accurately retrieved and reasoned over |
| **LoCoMo** (Long Conversation Memory) | Memory over 50+ turn conversations | Mem0 | Tests consistency across very long interactions |
| **HotPotQA** (multi-hop) | Multi-step reasoning over knowledge | Cognee / graph-based | Tests if agent can chain facts to reach answers |

If your use case maps to LoCoMo (long conversations), prioritize Mem0. If it maps to HotPotQA (reasoning over knowledge bases), prioritize graph-based systems.

## Retrieval Strategies

Choosing what to retrieve is as important as what to store:

### 1. Semantic similarity (cosine)
Default for most systems. Retrieves facts with similar meaning.
- **Use when:** General-purpose memory, conversation history
- **Failure mode:** Retrieves semantically similar but contextually wrong facts

### 2. Recency + relevance hybrid
Score = `α × semantic_similarity + (1-α) × recency_score`
- **Use when:** Recent facts should outweigh older, equally-relevant facts
- `α = 0.7` is a reasonable starting point

### 3. Entity-anchored retrieval
Always retrieve all known facts about entities mentioned in the current query.
- **Use when:** Entity-heavy tasks (CRM, user management, project tracking)
- **Implementation:** Extract entities from query → graph lookup → inject facts

### 4. Working memory injection
Maintain a compact "current context" block that always appears in context. Updated at key moments.
- **Use when:** Agent needs persistent awareness of current task state
- **Pattern:** `CURRENT_TASK.md` or a Redis key read at session start

### 5. Temporal-aware retrieval
Retrieve only facts valid at the query timestamp.
- **Use when:** Historical questions, audit trails, slowly-changing entities
- **Requires:** Temporal KG (Zep/Graphiti)

## Production Implementation Patterns

### Hive-Specific Memory Layers

For Hive's agent architecture, map memory types to existing infrastructure:

| Memory Need | Recommended Storage | Access Pattern |
|-------------|--------------------|-----------------|
| Company state, cycle data | Neon (structured) | API queries |
| Playbook, agent learnings | Neon `playbook` table | Pre-session injection |
| Temporary agent context | Redis (Upstash, TTL 1h) | Read at dispatch |
| Feature flags, settings | Edge Config | Read at edge |
| Research reports | Vercel Blob | On-demand fetch |
| Agent prompts | Neon `agent_prompts` | Pre-session injection |

### Memory Injection Protocol

1. **Pre-session:** Inject static context (company state, playbook, recent actions)
2. **On retrieval:** Semantic search for task-relevant memories
3. **Post-session:** Extract and store decisions, outcomes, learnings
4. **Cross-session:** Summarize episodic memories into semantic facts

### Avoiding Memory Pollution

Memory systems degrade when they accumulate noise:

- **Contradiction detection:** Before storing a fact, check if a conflicting fact exists. Update rather than append.
- **Confidence decay:** Facts not reinforced over time should have reduced retrieval weight.
- **Recency bias correction:** Recent events are over-represented in memory. Balance with importance scoring.
- **Structured extraction:** Use LLM to extract structured facts (`entity`, `relation`, `value`) rather than storing raw text.

## Practical Escalation Path

1. **Prototype:** Filesystem memory + manual context injection. Zero dependencies.
2. **Scale:** Add Upstash Redis for fast recent-memory access + pgvector for semantic search.
3. **Complex reasoning:** Add Zep/Graphiti for temporal facts or Mem0 for user-level personalization.
4. **Full control:** Self-hosted Letta for autonomous agents that manage their own memory.

Don't start at step 4. Most systems never need it.

## Anti-Patterns

- **Everything in context:** Injecting all memory into every request burns tokens and dilutes attention. Use retrieval.
- **Raw text storage:** Storing conversation turns verbatim. Extract structured facts instead.
- **Single store for all types:** Working memory, long-term facts, and entity relationships have different access patterns. Separate them.
- **No expiry:** Stale facts accumulate without TTL or confidence decay. Add both.
- **No contradiction handling:** Storing "X is true" and later "X is false" without resolving creates confusion. Always check before writing.

## Related Skills

multi-agent-patterns, filesystem-context, context-optimization, tool-design
