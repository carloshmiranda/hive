import { getDb } from "./db";

/**
 * Migration script to set up dynamic routing tables and backfill initial data
 */

export async function migrateRouting(): Promise<void> {
  const sql = getDb();

  try {
    console.log("Creating dynamic routing tables...");

    // Create the routing tables
    await sql`
      -- Model routing table: tracks success rates and Q-values for agent-model combinations
      CREATE TABLE IF NOT EXISTS model_routing (
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
      )
    `;

    await sql`
      -- Model choices log: tracks which model was selected for exploration tracking
      CREATE TABLE IF NOT EXISTS model_choices (
        id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        agent          TEXT NOT NULL,
        model_config   JSONB NOT NULL,
        context_factors JSONB DEFAULT '{}',
        chosen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    // Create the Q-value calculation function
    await sql`
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
      $$ LANGUAGE plpgsql IMMUTABLE
    `;

    // Create indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_model_routing_agent_active
      ON model_routing(agent) WHERE is_active = true
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_model_routing_q_value
      ON model_routing(agent, q_value DESC) WHERE is_active = true
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_model_choices_agent_time
      ON model_choices(agent, chosen_at DESC)
    `;

    // Create update trigger
    await sql`
      CREATE OR REPLACE FUNCTION update_model_routing_timestamp()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.last_updated = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;

    await sql`
      DROP TRIGGER IF EXISTS trigger_update_model_routing_timestamp ON model_routing
    `;

    await sql`
      CREATE TRIGGER trigger_update_model_routing_timestamp
        BEFORE UPDATE ON model_routing
        FOR EACH ROW
        EXECUTE FUNCTION update_model_routing_timestamp()
    `;

    // Create performance view
    await sql`
      CREATE OR REPLACE VIEW routing_performance AS
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
      ORDER BY agent, q_value DESC
    `;

    console.log("Dynamic routing tables created successfully");

    // Backfill initial data from recent agent_actions
    console.log("Backfilling routing data from recent agent actions...");
    await backfillFromAgentActions();

    console.log("Dynamic routing migration completed successfully");

  } catch (error) {
    console.error("Dynamic routing migration failed:", error);
    throw error;
  }
}

/**
 * Backfill routing data from existing agent_actions
 */
async function backfillFromAgentActions(): Promise<void> {
  const sql = getDb();

  // Get recent completed actions with provider/model info
  const actions = await sql`
    SELECT
      agent,
      action_type,
      status,
      company_id,
      output,
      EXTRACT(EPOCH FROM (finished_at - started_at))::int as duration_s
    FROM agent_actions
    WHERE status IN ('success', 'failed')
      AND finished_at > NOW() - INTERVAL '30 days'
      AND output IS NOT NULL
      AND output->>'provider' IS NOT NULL
    ORDER BY finished_at ASC
  `;

  console.log(`Processing ${actions.length} agent actions for routing data...`);

  for (const action of actions) {
    try {
      const output = action.output as any;
      const provider = output.provider;
      const model = output.model;

      if (!provider || !model) continue;

      const modelConfig = {
        provider,
        model,
        ...(output.max_turns && { max_turns: output.max_turns }),
      };

      const success = action.status === "success";
      const durationS = action.duration_s || 0;

      // Insert or update routing record
      await sql`
        INSERT INTO model_routing (
          agent,
          model_config,
          success_count,
          failure_count,
          total_duration_s,
          sample_size,
          q_value,
          confidence,
          context_factors
        )
        VALUES (
          ${action.agent},
          ${JSON.stringify(modelConfig)},
          ${success ? 1 : 0},
          ${success ? 0 : 1},
          ${durationS},
          1,
          ${success ? 1.0 : 0.0},
          0.1,
          ${JSON.stringify({ action_type: action.action_type, company_id: action.company_id })}
        )
        ON CONFLICT (agent, model_config_hash)
        DO UPDATE SET
          success_count = model_routing.success_count + ${success ? 1 : 0},
          failure_count = model_routing.failure_count + ${success ? 0 : 1},
          total_duration_s = model_routing.total_duration_s + ${durationS},
          sample_size = model_routing.sample_size + 1,
          q_value = calculate_q_value(
            model_routing.success_count + ${success ? 1 : 0},
            model_routing.sample_size + 1,
            model_routing.total_duration_s + ${durationS}
          ),
          confidence = LEAST(1.0, (model_routing.sample_size + 1) / 50.0),
          last_updated = NOW()
      `;

    } catch (error) {
      console.warn(`Failed to process action for agent ${action.agent}:`, error);
    }
  }

  console.log("Routing data backfill completed");
}

/**
 * Check if dynamic routing tables exist
 */
export async function hasRoutingTables(): Promise<boolean> {
  try {
    const sql = getDb();
    const result = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'model_routing'
      ) as has_routing_table
    `;
    return result[0]?.has_routing_table || false;
  } catch {
    return false;
  }
}