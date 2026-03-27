# Ruflo Intelligence & Memory (pasted by Carlos)

The system stores successful patterns in vector memory, builds a knowledge graph for structural understanding, learns from outcomes via neural networks, and adapts routing based on what works best.

| Layer | Components | What It Does |
|-------|-----------|--------------|
| Memory | HNSW, AgentDB, Cache | Stores and retrieves patterns with fast HNSW search |
| Knowledge Graph | MemoryGraph, PageRank, Communities | Identifies influential insights, detects clusters (ADR-049) |
| Self-Learning | LearningBridge, SONA, ReasoningBank | Triggers learning from insights, confidence lifecycle (ADR-049) |
| Agent Scopes | AgentMemoryScope, 3-scope dirs | Per-agent isolation + cross-agent knowledge transfer (ADR-049) |
| Embeddings | ONNX Runtime, MiniLM | Local vectors without API calls (75x faster) |
| Learning | SONA, MoE, ReasoningBank | Self-improves from results (<0.05ms adaptation) |
| Fine-tuning | MicroLoRA, EWC++ | Lightweight adaptation without full retraining |
