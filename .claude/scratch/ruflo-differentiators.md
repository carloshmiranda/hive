# Ruflo Key Differentiators (pasted by Carlos)

10 capabilities that work together: self-learning, memory optimization, fault tolerance.

| # | Feature | What It Does | Technical Details |
|---|---------|-------------|------------------|
| 1 | SONA | Learns which agents perform best for each task type and routes work accordingly | Self-Optimizing Neural Architecture |
| 2 | EWC++ | Preserves learned patterns when training on new ones — no forgetting | Elastic Weight Consolidation prevents catastrophic forgetting |
| 3 | MoE | Routes tasks through 8 specialized expert networks based on task type | Mixture of 8 Experts with dynamic gating |
| 4 | Flash Attention | Accelerates attention computation for faster agent responses | Optimized attention via @ruvector/attention |
| 5 | Hyperbolic Embeddings | Represents hierarchical code relationships in compact vector space | Poincare ball model for hierarchical data |
| 6 | LoRA | Lightweight model adaptation so agents fit in limited memory | Low-Rank Adaptation via @ruvector/sona |
| 7 | Int8 Quantization | Converts 32-bit weights to 8-bit with minimal accuracy loss | ~4x memory reduction with calibrated integers |
| 8 | Claims System | Manages task ownership between humans and agents with handoff support | Work ownership with claim/release/handoff protocols |
| 9 | Byzantine Consensus | Coordinates agents even when some fail or return bad results | Fault-tolerant, handles up to 1/3 failing agents |
| 10 | RuVector PostgreSQL | Enterprise-grade vector database with 77+ SQL functions for AI operations | Fast vector search with GNN/attention in SQL |
