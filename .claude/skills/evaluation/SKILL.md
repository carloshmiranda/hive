---
name: evaluation
description: This skill should be used when the user wants to evaluate AI agent quality, measure agent performance, design test sets for agents, implement LLM-as-judge evaluation, build rubrics for agent outputs, set up continuous evaluation pipelines, create regression test suites, or mentions evaluation frameworks, golden datasets, benchmark design, agent scoring, pass rate thresholds, or output quality measurement.
metadata:
  version: 1.1.0
---

# Agent Evaluation

Agents that aren't measured drift. Evaluation is the feedback loop that closes the gap between "seems to work" and "provably works." Without structured evaluation, prompt changes, model updates, and new edge cases silently degrade quality.

## When to Activate

Activate this skill when:
- Shipping a new agent or significantly changing an existing one
- Choosing between prompt variants or model configurations
- Setting up a production monitoring pipeline
- Investigating quality degradation reports
- Building a continuous improvement loop for agent systems

## Four Pillars

---

### Pillar 1: Multi-Dimensional Rubrics

Single-metric evaluation misses failure modes. Rate each output across independent dimensions.

**Core dimensions for most agents:**

| Dimension | What It Measures | Scoring |
|-----------|-----------------|---------|
| **Task Completion** | Did the agent accomplish the stated objective? | 0-3: fail / partial / complete / complete+correct |
| **Reasoning Quality** | Is the chain of thought sound and relevant? | 0-2: flawed / adequate / strong |
| **Instruction Following** | Did the agent follow all stated constraints? | 0-1 per constraint |
| **Tool Use Efficiency** | Did the agent use tools appropriately and minimally? | 0-2: unnecessary calls / appropriate / optimal |
| **Response Quality** | Is the output well-structured and appropriately scoped? | 0-2: poor / adequate / excellent |

**Dimension weighting:**

Weight dimensions by what matters for the specific agent:
- Task agents (Engineer, Growth): Task Completion × 3, Instruction Following × 2
- Reasoning agents (CEO, Scout): Reasoning Quality × 3, Task Completion × 2
- Tool-heavy agents (Ops, Healer): Tool Use Efficiency × 3, Task Completion × 2

**Scoring approach:**

```
Final score = Σ(dimension_score × dimension_weight) / Σ(max_score × dimension_weight)
```

Target score ≥ 0.75 for production readiness. Score < 0.60 → rework prompt or system design.

**Rubric for task completion (example):**

```
Score 0: Agent failed to address the task, went off-topic, or produced harmful output
Score 1: Agent partially addressed the task but missed key requirements
Score 2: Agent addressed the task completely but with minor errors or omissions
Score 3: Agent addressed the task completely and correctly, with no significant issues
```

---

### Pillar 2: LLM-as-Judge

Human evaluation doesn't scale. LLM judges can evaluate thousands of outputs at the cost of a few hundred tokens each.

**Critical rule: Use a different model family than the agent being evaluated.**

If your agent runs on Claude, judge with GPT-4 or Gemini. If it runs on GPT-4, judge with Claude.

**Why:** Models exhibit self-enhancement bias — they score outputs from their own model family higher regardless of actual quality. LangChain benchmarks show 15-25% higher scores when models self-evaluate vs. cross-model evaluation. This bias invalidates comparisons between models.

**Judge prompt structure:**

```
You are evaluating the output of an AI agent. Score the output on the following dimensions.

## Task
{task_description}

## Agent Output
{agent_output}

## Scoring Rubric
{rubric_text}

## Instructions
- Score each dimension independently
- Cite specific evidence from the output for each score
- Do NOT consider your preferences — only evaluate against the rubric
- Output JSON: { "dimension_name": { "score": N, "evidence": "..." }, ... }
```

**Calibration:** Run the judge against 20-30 human-labeled examples. Accept the judge if correlation with human scores ≥ 0.85. Below 0.75 → refine the rubric or judge prompt.

**Cost efficiency:**

| Evaluation approach | Cost per 1K evaluations | Correlation with human |
|--------------------|------------------------|----------------------|
| Human evaluation | ~$500-2,000 | 1.0 (baseline) |
| Same-family LLM judge | ~$2-10 | 0.60-0.75 (biased) |
| Cross-family LLM judge | ~$2-10 | 0.80-0.92 |
| Smaller model with calibrated rubric | ~$0.20-1 | 0.75-0.85 |

---

### Pillar 3: Test Set Design

**Minimum: 50 test cases.** Below 50, variance swamps signal — a 2-case improvement looks like a 4% win but could be noise.

**Stratification requirements:**

| Category | % of Test Set | Purpose |
|----------|--------------|---------|
| Typical cases | 40% | Representative of production distribution |
| Edge cases | 25% | Unusual inputs, boundary conditions |
| Hard cases | 20% | Cases where the agent is known to struggle |
| Adversarial cases | 15% | Prompt injections, contradictions, trap instructions |

**Golden dataset construction:**

1. **Sample from production** (if available): Take 50+ real interactions, have humans label the expected outputs
2. **Synthetic generation** (for new agents): Generate cases programmatically across the stratification matrix
3. **Expert review**: Every golden example should be reviewed by someone who understands the domain
4. **Version the dataset**: Store as `eval/golden_v{N}.jsonl` — never modify an existing version, only create new ones

**Test case format:**

```json
{
  "id": "tc_001",
  "category": "typical",
  "input": {
    "task": "...",
    "context": "...",
    "tools_available": [...]
  },
  "expected": {
    "outcome": "...",
    "constraints_satisfied": ["...", "..."],
    "tools_used": ["..."]
  },
  "rubric_weights": {
    "task_completion": 3,
    "instruction_following": 2
  }
}
```

**Regression set:** Maintain a subset of 15-20 cases specifically targeting previously-fixed failure modes. A passing evaluation suite that fails on regression cases means the agent regressed.

---

### Pillar 4: Continuous Evaluation

Evaluation isn't one-time. Models change, prompts drift, production inputs diverge from test sets.

**Sampling protocol:**

Sample 5-10% of all production interactions for ongoing evaluation. At 100 agent runs/day, this is 5-10 evaluations/day — manageable and statistically meaningful over a week.

**Alert thresholds:**

```
Pass rate ≥ 0.85  →  HEALTHY. No action needed.
Pass rate 0.70-0.84  →  WARNING. Review recent failures, check for systematic issues.
Pass rate < 0.70  →  CRITICAL. Halt new deployments. Root-cause required before proceeding.
```

**Failure triage:**

When pass rate drops, categorize failures before acting:
1. **Prompt issue**: Multiple failures on similar task types → refine prompt
2. **Model regression**: Failures started after a model update → consider pinning model version
3. **Distribution shift**: Production inputs don't match training distribution → expand golden dataset
4. **Edge case cluster**: Failures concentrated on a new input pattern → add targeted test cases

**Evaluation pipeline (implementation):**

```typescript
// Triggered after each agent run or sampled from production
async function evaluateAgentRun(run: AgentRun): Promise<EvalResult> {
  const rubric = await loadRubric(run.agentType);
  const judgeModel = getJudgeModel(run.agentModel); // cross-family selection

  const scores = await judgeModel.generateObject({
    schema: EvalScoreSchema,
    prompt: buildJudgePrompt(run, rubric),
  });

  const passRate = scores.total / scores.maxPossible;

  await saveEvalResult({ runId: run.id, scores, passRate });

  if (passRate < ALERT_THRESHOLD_CRITICAL) {
    await notifyOperator(`Critical eval failure on ${run.agentType}: ${passRate}`);
  }

  return { passRate, scores, passed: passRate >= PASS_THRESHOLD };
}
```

---

## The BrowseComp Finding

Research on the BrowseComp evaluation found that **token usage explains 80% of performance variance** across agent architectures, with number of tool calls and model choice explaining most of the rest.

**Implication:** Before concluding that your architecture is the bottleneck, increase token budget. A 2x token budget often outperforms a more complex architectural change.

**Secondary finding:** Model quality improvements frequently outperform doubling token budget. When both budget and model are suboptimal, upgrade the model first.

**Application to evaluation:**

When comparing agent variants, control for token usage. An agent that uses 3x the tokens is not "better" if the pass rate improvement is proportional to token count — it's just more expensive.

```
Efficiency score = pass_rate / (tokens_used / baseline_tokens)
```

---

## Evaluation Anti-Patterns

- **Single-score evaluation**: One number hides which dimensions are failing. Always use multi-dimensional rubrics.
- **Self-evaluation**: Using the same model to judge its own outputs inflates scores 15-25%. Always cross-family.
- **Small test sets**: <20 cases produces misleading pass rates. Minimum 50, preferably 100+.
- **Static evaluation**: Running evals once at launch misses drift. Continuous sampling is required for production agents.
- **Evaluating only happy paths**: If your test set doesn't include adversarial cases, you won't discover injection vulnerabilities until production.
- **Rubric drift**: Changing rubrics between evaluations makes historical comparisons meaningless. Version rubrics alongside test sets.
- **Ignoring calibration**: If your LLM judge doesn't correlate ≥0.85 with human judgments, it's measuring something other than quality.

## Related Skills

context-optimization, multi-agent-patterns, tool-design, memory-systems
