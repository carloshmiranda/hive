/**
 * Static schema map — single source of truth for Hive's Neon schema.
 *
 * Used by Sentinel to detect schema drift at runtime.
 * Regenerate with: npx tsx scripts/generate-schema-map.ts
 *
 * Each table lists its columns with type and nullable flag.
 * CHECK constraints on enum-like columns are also tracked so Sentinel
 * can detect when code tries to insert a value the DB doesn't allow.
 */

export interface ColumnDef {
  type: string;
  nullable: boolean;
  hasDefault: boolean;
}

export interface CheckConstraint {
  column: string;
  allowedValues: string[];
}

export interface TableDef {
  columns: Record<string, ColumnDef>;
  checks: CheckConstraint[];
}

export const SCHEMA_MAP: Record<string, TableDef> = {
  "companies": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "name": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "slug": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "description": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "vercel_project_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "vercel_url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "github_repo": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "neon_project_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "stripe_account_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "domain": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "capabilities": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": true
      },
      "company_type": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": true
      },
      "framework": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": true
      },
      "market": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": true
      },
      "content_language": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": true
      },
      "imported": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": true
      },
      "last_assessed_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "updated_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "killed_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "kill_reason": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "status",
        "allowedValues": [
          "idea",
          "approved",
          "provisioning",
          "mvp",
          "active",
          "paused",
          "killed"
        ]
      }
    ]
  },
  "cycles": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "cycle_number": {
        "type": "INTEGER",
        "nullable": false,
        "hasDefault": false
      },
      "started_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "finished_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "ceo_plan": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "ceo_review": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "status",
        "allowedValues": [
          "running",
          "completed",
          "failed",
          "partial"
        ]
      }
    ]
  },
  "agent_actions": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "cycle_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "company_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "agent": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "action_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "description": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "input": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "output": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "error": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "retry_count": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "reflection": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "started_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "finished_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "tokens_used": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "agent",
        "allowedValues": [
          "ceo",
          "scout",
          "engineer",
          "ops",
          "growth",
          "outreach",
          "evolver",
          "healer",
          "orchestrator",
          "sentinel",
          "auto_merge",
          "dispatch",
          "backlog_dispatch",
          "webhook",
          "system",
          "admin"
        ]
      },
      {
        "column": "status",
        "allowedValues": [
          "pending",
          "running",
          "success",
          "failed",
          "skipped",
          "escalated",
          "pending_manual",
          "completed",
          "flagged"
        ]
      }
    ]
  },
  "approvals": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "gate_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "title": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "description": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "context": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "decided_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "decision_note": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "gate_type",
        "allowedValues": [
          "new_company",
          "growth_strategy",
          "spend_approval",
          "kill_company",
          "prompt_upgrade",
          "escalation",
          "outreach_batch",
          "vercel_pro_upgrade",
          "social_account",
          "first_revenue",
          "capability_migration",
          "pr_review"
        ]
      },
      {
        "column": "status",
        "allowedValues": [
          "pending",
          "approved",
          "rejected",
          "expired"
        ]
      }
    ]
  },
  "metrics": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "date": {
        "type": "DATE",
        "nullable": false,
        "hasDefault": false
      },
      "revenue": {
        "type": "NUMERIC(12,2)",
        "nullable": true,
        "hasDefault": true
      },
      "mrr": {
        "type": "NUMERIC(12,2)",
        "nullable": true,
        "hasDefault": true
      },
      "customers": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "page_views": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "signups": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "churn_rate": {
        "type": "NUMERIC(5,4)",
        "nullable": true,
        "hasDefault": true
      },
      "cac": {
        "type": "NUMERIC(10,2)",
        "nullable": true,
        "hasDefault": true
      },
      "ad_spend": {
        "type": "NUMERIC(10,2)",
        "nullable": true,
        "hasDefault": true
      },
      "emails_sent": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "social_posts": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "social_engagement": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "waitlist_signups": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "waitlist_total": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "email_opens": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "email_clicks": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "email_bounces": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "pricing_page_views": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "pricing_cta_clicks": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "affiliate_clicks": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "affiliate_revenue": {
        "type": "NUMERIC(10,2)",
        "nullable": true,
        "hasDefault": true
      }
    },
    "checks": []
  },
  "playbook": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "source_company_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "domain": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "insight": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "evidence": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "confidence": {
        "type": "NUMERIC(3,2)",
        "nullable": true,
        "hasDefault": true
      },
      "applied_count": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "superseded_by": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "content_language": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": true
      },
      "last_referenced_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "reference_count": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "relevant_agents": {
        "type": "TEXT[]",
        "nullable": true,
        "hasDefault": true
      }
    },
    "checks": []
  },
  "agent_prompts": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "agent": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "version": {
        "type": "INTEGER",
        "nullable": false,
        "hasDefault": false
      },
      "prompt_text": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "is_active": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": true
      },
      "performance_score": {
        "type": "NUMERIC(5,4)",
        "nullable": true,
        "hasDefault": false
      },
      "sample_size": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "promoted_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": []
  },
  "infra": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "service": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "resource_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "config": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "torn_down_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "status",
        "allowedValues": [
          "provisioning",
          "active",
          "failed",
          "torn_down"
        ]
      }
    ]
  },
  "social_accounts": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "platform": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "account_handle": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "auth_token": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": [
      {
        "column": "platform",
        "allowedValues": [
          "x",
          "linkedin",
          "instagram",
          "tiktok",
          "youtube"
        ]
      },
      {
        "column": "status",
        "allowedValues": [
          "pending",
          "active",
          "expired",
          "disabled"
        ]
      }
    ]
  },
  "directives": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "agent": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "text": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "github_issue_number": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": false
      },
      "github_issue_url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "resolution": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "resolved_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "status",
        "allowedValues": [
          "open",
          "in_progress",
          "done",
          "rejected"
        ]
      }
    ]
  },
  "imports": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "source_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "source_url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "scan_status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "scan_report": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "onboard_status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": [
      {
        "column": "source_type",
        "allowedValues": [
          "github_repo",
          "external_repo",
          "vercel_project",
          "manual"
        ]
      },
      {
        "column": "scan_status",
        "allowedValues": [
          "pending",
          "scanning",
          "scanned",
          "failed"
        ]
      },
      {
        "column": "onboard_status",
        "allowedValues": [
          "pending",
          "in_progress",
          "complete",
          "failed"
        ]
      }
    ]
  },
  "settings": {
    "columns": {
      "key": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "value": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "is_secret": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": true
      },
      "updated_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": true
      }
    },
    "checks": []
  },
  "research_reports": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "report_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "content": {
        "type": "JSONB",
        "nullable": false,
        "hasDefault": false
      },
      "summary": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "sources": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "updated_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": [
      {
        "column": "report_type",
        "allowedValues": [
          "market_research",
          "competitive_analysis",
          "lead_list",
          "seo_keywords",
          "outreach_log",
          "visibility_snapshot",
          "llm_visibility",
          "content_performance",
          "content_gaps",
          "product_spec"
        ]
      }
    ]
  },
  "visibility_metrics": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "date": {
        "type": "DATE",
        "nullable": false,
        "hasDefault": false
      },
      "source": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "keyword": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "impressions": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "clicks": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "position": {
        "type": "NUMERIC(6,2)",
        "nullable": true,
        "hasDefault": false
      },
      "ctr": {
        "type": "NUMERIC(5,4)",
        "nullable": true,
        "hasDefault": false
      },
      "cited": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": false
      },
      "mentioned": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": false
      },
      "competitors": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": [
      {
        "column": "source",
        "allowedValues": [
          "gsc",
          "bwt",
          "llm_gemini",
          "vercel"
        ]
      }
    ]
  },
  "dismissed_todos": {
    "columns": {
      "todo_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "dismissed_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": []
  },
  "evolver_proposals": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "gap_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "severity": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "title": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "diagnosis": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "signal_source": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "signal_data": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": true
      },
      "proposed_fix": {
        "type": "JSONB",
        "nullable": false,
        "hasDefault": false
      },
      "affected_companies": {
        "type": "TEXT[]",
        "nullable": true,
        "hasDefault": true
      },
      "cross_company": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": true
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "playbook_entry_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "reviewed_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "implemented_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "decided_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "notes": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "gap_type",
        "allowedValues": [
          "outcome",
          "capability",
          "knowledge",
          "process"
        ]
      },
      {
        "column": "severity",
        "allowedValues": [
          "critical",
          "high",
          "medium",
          "low"
        ]
      },
      {
        "column": "status",
        "allowedValues": [
          "pending",
          "approved",
          "rejected",
          "implemented",
          "deferred"
        ]
      }
    ]
  },
  "context_log": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "source": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "category": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "summary": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "detail": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "related_adr": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "related_file": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "tags": {
        "type": "TEXT[]",
        "nullable": true,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": [
      {
        "column": "source",
        "allowedValues": [
          "chat",
          "code",
          "orch",
          "carlos"
        ]
      },
      {
        "column": "category",
        "allowedValues": [
          "decision",
          "learning",
          "brainstorm",
          "blocker",
          "milestone",
          "question"
        ]
      }
    ]
  },
  "company_tasks": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "category": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "title": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "description": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "priority": {
        "type": "INT",
        "nullable": false,
        "hasDefault": true
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "source": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "prerequisites": {
        "type": "TEXT[]",
        "nullable": true,
        "hasDefault": true
      },
      "acceptance": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "cycle_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "github_issue_number": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": false
      },
      "github_issue_url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "pr_number": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": false
      },
      "pr_url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "spec": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "updated_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": [
      {
        "column": "category",
        "allowedValues": [
          "engineering",
          "growth",
          "research",
          "qa",
          "ops",
          "strategy"
        ]
      },
      {
        "column": "status",
        "allowedValues": [
          "proposed",
          "approved",
          "in_progress",
          "done",
          "dismissed"
        ]
      },
      {
        "column": "source",
        "allowedValues": [
          "ceo",
          "sentinel",
          "evolver",
          "carlos"
        ]
      }
    ]
  },
  "error_patterns": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "pattern": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "agent": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "fix_summary": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "fix_detail": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "source_action_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "occurrences": {
        "type": "INT",
        "nullable": true,
        "hasDefault": true
      },
      "last_seen_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": true
      },
      "resolved": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": true
      },
      "auto_fixable": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": true
      }
    },
    "checks": []
  },
  "hive_backlog": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "priority": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "title": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "description": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "category": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "status": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "source": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "dispatch_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "pr_number": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": false
      },
      "pr_url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "parent_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "decomposition_context": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "github_issue_number": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": false
      },
      "github_issue_url": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "theme": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "spec": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "notes": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "failure_count": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "is_stealable": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": true
      },
      "claimed_by": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "claimed_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "completion_percentage": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "contest_window_until": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "updated_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": true
      },
      "dispatched_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      },
      "completed_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "priority",
        "allowedValues": [
          "P0",
          "P1",
          "P2",
          "P3"
        ]
      },
      {
        "column": "category",
        "allowedValues": [
          "bugfix",
          "feature",
          "refactor",
          "infra",
          "quality",
          "research"
        ]
      },
      {
        "column": "status",
        "allowedValues": [
          "ready",
          "approved",
          "planning",
          "dispatched",
          "in_progress",
          "pr_open",
          "done",
          "blocked",
          "rejected"
        ]
      }
    ]
  },
  "routing_weights": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "task_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "model": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "agent": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "successes": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "failures": {
        "type": "INTEGER",
        "nullable": true,
        "hasDefault": true
      },
      "success_rate": {
        "type": "NUMERIC(5,4)",
        "nullable": true,
        "hasDefault": false
      },
      "last_updated": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": []
  },
  "context_cache": {
    "columns": {
      "cache_key": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "agent_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "cycle_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "context_data": {
        "type": "JSONB",
        "nullable": false,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "expires_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      }
    },
    "checks": [
      {
        "column": "agent_type",
        "allowedValues": [
          "build",
          "growth",
          "fix"
        ]
      }
    ]
  },
  "decision_log": {
    "columns": {
      "id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": true
      },
      "company_id": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "decision_type": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "cycle_id": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "reasoning": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "expected_outcome": {
        "type": "TEXT",
        "nullable": false,
        "hasDefault": false
      },
      "actual_outcome": {
        "type": "TEXT",
        "nullable": true,
        "hasDefault": false
      },
      "was_correct": {
        "type": "BOOLEAN",
        "nullable": true,
        "hasDefault": false
      },
      "decision_data": {
        "type": "JSONB",
        "nullable": true,
        "hasDefault": false
      },
      "created_at": {
        "type": "TIMESTAMPTZ",
        "nullable": false,
        "hasDefault": true
      },
      "validated_at": {
        "type": "TIMESTAMPTZ",
        "nullable": true,
        "hasDefault": false
      }
    },
    "checks": [
      {
        "column": "decision_type",
        "allowedValues": [
          "kill",
          "pivot",
          "phase_change",
          "priority_shift"
        ]
      }
    ]
  }
};

/**
 * Validate that a column exists on a table.
 * Returns null if valid, or an error string if the column doesn't exist.
 */
export function validateColumn(table: string, column: string): string | null {
  const tableDef = SCHEMA_MAP[table];
  if (!tableDef) return `Table '${table}' not in schema map`;
  if (!tableDef.columns[column]) return `Column '${table}.${column}' does not exist. Available: ${Object.keys(tableDef.columns).join(", ")}`;
  return null;
}

/**
 * Validate that a value is allowed by a CHECK constraint.
 * Returns null if valid (or no check exists), or an error string.
 */
export function validateCheckValue(table: string, column: string, value: string): string | null {
  const tableDef = SCHEMA_MAP[table];
  if (!tableDef) return null;
  const check = tableDef.checks.find(c => c.column === column);
  if (!check) return null;
  if (!check.allowedValues.includes(value)) {
    return `Value '${value}' not allowed for ${table}.${column}. Allowed: ${check.allowedValues.join(", ")}`;
  }
  return null;
}

/**
 * Get all expected tables and their column counts.
 * Used by Sentinel to compare against live DB.
 */
export function getExpectedTables(): Array<{ table: string; columnCount: number }> {
  return Object.entries(SCHEMA_MAP).map(([table, def]) => ({
    table,
    columnCount: Object.keys(def.columns).length,
  }));
}
