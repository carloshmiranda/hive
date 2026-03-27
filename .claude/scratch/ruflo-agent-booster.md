# Ruflo Agent Booster WASM (pasted by Carlos)

Agent Booster uses WebAssembly to handle simple code transformations without calling the LLM at all. When the hooks system detects a simple task, it routes directly to Agent Booster for instant results.

Supported Transform Intents:

| Intent | What It Does | Example |
|--------|-------------|---------|
| var-to-const | Convert var/let to const | var x = 1 → const x = 1 |
| add-types | Add TypeScript type annotations | function foo(x) → function foo(x: string) |
| add-error-handling | Wrap in try/catch | Adds proper error handling |
| async-await | Convert promises to async/await | .then() chains → await |
| add-logging | Add console.log statements | Adds debug logging |
| remove-console | Strip console.* calls | Removes all console statements |
