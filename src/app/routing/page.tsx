"use client";

import { useState, useEffect } from "react";

interface RoutingStats {
  by_agent: Record<string, Array<{
    model: any;
    success_rate: number;
    sample_size: number;
    q_value: number;
    confidence: number;
    avg_duration_s: number;
  }>>;
  recommendations: string[];
}

interface MigrationStatus {
  migration_needed: boolean;
  has_routing_tables: boolean;
}

export default function RoutingPage() {
  const [stats, setStats] = useState<RoutingStats | null>(null);
  const [migration, setMigration] = useState<MigrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [migrating, setMigrating] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      // Check migration status
      const migrationRes = await fetch("/api/routing/migrate");
      const migrationData = await migrationRes.json();
      setMigration(migrationData.data);

      // Load stats if tables exist
      if (!migrationData.data.migration_needed) {
        const statsRes = await fetch("/api/routing");
        const statsData = await statsRes.json();
        setStats(statsData.data);
      }
    } catch (error) {
      console.error("Failed to load routing data:", error);
    } finally {
      setLoading(false);
    }
  };

  const runMigration = async () => {
    setMigrating(true);
    try {
      const res = await fetch("/api/routing/migrate", { method: "POST" });
      const data = await res.json();

      if (data.ok) {
        await loadData(); // Reload data after migration
      } else {
        alert("Migration failed: " + data.error);
      }
    } catch (error) {
      alert("Migration failed: " + error);
    } finally {
      setMigrating(false);
    }
  };

  const resetAgent = async (agent: string) => {
    try {
      const res = await fetch("/api/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", agent })
      });

      if (res.ok) {
        await loadData(); // Reload data
      } else {
        alert("Reset failed");
      }
    } catch (error) {
      alert("Reset failed: " + error);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Dynamic Model Routing</h1>
        <p>Loading...</p>
      </div>
    );
  }

  if (migration?.migration_needed) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Dynamic Model Routing</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded p-4 mb-6">
          <h2 className="font-semibold text-yellow-800 mb-2">Migration Required</h2>
          <p className="text-yellow-700 mb-4">
            Dynamic routing tables need to be created. This will set up Q-Learning style
            model selection and backfill data from recent agent executions.
          </p>
          <button
            onClick={runMigration}
            disabled={migrating}
            className="bg-yellow-600 text-white px-4 py-2 rounded hover:bg-yellow-700 disabled:opacity-50"
          >
            {migrating ? "Migrating..." : "Run Migration"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Dynamic Model Routing</h1>

      {stats?.recommendations && stats.recommendations.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded p-4 mb-6">
          <h2 className="font-semibold text-red-800 mb-2">Recommendations</h2>
          <ul className="text-red-700 space-y-1">
            {stats.recommendations.map((rec, i) => (
              <li key={i} className="text-sm">• {rec}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6">
        {Object.entries(stats?.by_agent || {}).map(([agent, models]) => (
          <div key={agent} className="bg-white border rounded-lg p-4">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-lg font-semibold capitalize">{agent}</h2>
              <button
                onClick={() => resetAgent(agent)}
                className="text-sm bg-gray-100 text-gray-600 px-3 py-1 rounded hover:bg-gray-200"
              >
                Reset Data
              </button>
            </div>

            <div className="space-y-2">
              {models.map((model, i) => (
                <div key={i} className="flex items-center justify-between text-sm bg-gray-50 p-3 rounded">
                  <div className="flex-1">
                    <span className="font-mono text-gray-600">
                      {model.model.provider}/{model.model.model}
                    </span>
                  </div>
                  <div className="flex items-center space-x-4 text-right">
                    <div>
                      <div className="font-semibold">{(model.success_rate * 100).toFixed(1)}%</div>
                      <div className="text-xs text-gray-500">{model.sample_size} samples</div>
                    </div>
                    <div>
                      <div className="font-semibold">Q: {model.q_value.toFixed(3)}</div>
                      <div className="text-xs text-gray-500">conf: {model.confidence.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="font-semibold">{model.avg_duration_s}s</div>
                      <div className="text-xs text-gray-500">avg time</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {models.length === 0 && (
              <p className="text-gray-500 text-sm">No routing data yet for this agent</p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 text-sm text-gray-600">
        <p><strong>Q-Value:</strong> Learning score combining success rate, speed, and confidence</p>
        <p><strong>Confidence:</strong> How reliable the Q-value is (based on sample size)</p>
        <p><strong>Success Rate:</strong> Percentage of successful executions with this model</p>
      </div>
    </div>
  );
}