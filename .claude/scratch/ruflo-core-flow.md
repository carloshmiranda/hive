# Ruflo Core Flow (pasted by Carlos)

Every request flows through four layers: from your CLI or Claude Code interface, through intelligent routing, to specialized agents, and finally to LLM providers for reasoning.

| Layer | Components | What It Does |
|-------|-----------|--------------|
| User | Claude Code, CLI | Your interface to control and run commands |
| Orchestration | MCP Server, Router, Hooks | Routes requests to the right agents |
| Agents | 60+ types | Specialized workers (coder, tester, reviewer...) |
| Providers | Anthropic, OpenAI, Google, Ollama | AI models that power reasoning |
