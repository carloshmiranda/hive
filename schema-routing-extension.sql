-- Dynamic Model Routing Extension
-- Q-Learning style adaptation for agent-model selection

-- Model routing table: tracks success rates and Q-values for agent-model combinations
CREATE TABLE model_routing (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent            TEXT NOT NULL CHECK (agent IN (
                     'ceo', 'scout', 'engineer', 'ops', 'growth', 'outreach', 'evolver', 'healer'
                   )),
  model_config     JSONB NOT NULL,           -- {"provider": "claude", "model": "opus", "max_turns": 25}
  model_config_hash TEXT GENERATED ALWAYS AS (
                     md5(model_config::text)
                   ) STORED,                   -- for unique constraint
  success_count    INTEGER DEFAULT 0,
  failure_count    INTEGER DEFAULT 0,
  total_duration_s INTEGER DEFAULT 0,
  sample_size      INTEGER DEFAULT 0,
  q_value          NUMERIC(5,4) DEFAULT 0,   -- Q-Learning value [0,1]
  confidence       NUMERIC(5,4) DEFAULT 0,   -- confidence in Q-value [0,1]
  context_factors  JSONB DEFAULT '{}',       -- last seen context
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at   TIMESTAMPTZ,
  UNIQUE(agent, model_config_hash)
);

-- Model choices log: tracks which model was selected for exploration tracking
CREATE TABLE model_choices (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent          TEXT NOT NULL,
  model_config   JSONB NOT NULL,
  context_factors JSONB DEFAULT '{}',
  chosen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Function to calculate Q-value based on success rate, sample size, and speed
CREATE OR REPLACE FUNCTION calculate_q_value(
  success_count INTEGER,
  sample_size INTEGER,
  total_duration_s INTEGER
) RETURNS NUMERIC(5,4) AS $$
DECLARE
  success_rate NUMERIC;
  speed_bonus NUMERIC;
  confidence_penalty NUMERIC;
BEGIN
  -- Base success rate
  success_rate := CASE
    WHEN sample_size > 0 THEN success_count::NUMERIC / sample_size::NUMERIC
    ELSE 0
  END;

  -- Speed bonus: faster execution gets slight bonus (max 0.05)
  speed_bonus := CASE
    WHEN total_duration_s > 0 AND sample_size > 0 THEN
      LEAST(0.05, 300.0 / (total_duration_s::NUMERIC / sample_size::NUMERIC) * 0.01)
    ELSE 0
  END;

  -- Confidence penalty: reduce Q-value for small samples
  confidence_penalty := CASE
    WHEN sample_size < 10 THEN (10 - sample_size) * 0.01
    ELSE 0
  END;

  RETURN GREATEST(0, LEAST(1, success_rate + speed_bonus - confidence_penalty));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Indexes for efficient routing queries
CREATE INDEX idx_model_routing_agent_active ON model_routing(agent) WHERE is_active = true;
CREATE INDEX idx_model_routing_q_value ON model_routing(agent, q_value DESC) WHERE is_active = true;
CREATE INDEX idx_model_choices_agent_time ON model_choices(agent, chosen_at DESC);

-- Trigger to update last_updated on model_routing changes
CREATE OR REPLACE FUNCTION update_model_routing_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_model_routing_timestamp
  BEFORE UPDATE ON model_routing
  FOR EACH ROW
  EXECUTE FUNCTION update_model_routing_timestamp();

-- View for easy routing analysis
CREATE VIEW routing_performance AS
SELECT
  agent,
  model_config,
  success_count,
  failure_count,
  sample_size,
  ROUND(success_count::NUMERIC / GREATEST(sample_size, 1), 3) as success_rate,
  ROUND(total_duration_s::NUMERIC / GREATEST(sample_size, 1), 1) as avg_duration_s,
  q_value,
  confidence,
  last_updated
FROM model_routing
WHERE is_active = true
  AND sample_size > 0
ORDER BY agent, q_value DESC;