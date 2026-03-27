# Ruflo Optimization (pasted by Carlos)

Skip expensive LLM calls for simple tasks using WebAssembly transforms, and compress tokens to reduce API costs by 30-50%.

| Layer | Components | What It Does |
|-------|-----------|--------------|
| Agent Booster | WASM, AST analysis | Skips LLM for simple edits (<1ms) |
| Token Optimizer | Compression, Caching | Reduces token usage 30-50% |
