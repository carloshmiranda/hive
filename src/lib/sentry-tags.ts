import * as Sentry from "@sentry/nextjs";

/**
 * Set Hive-specific Sentry tags for error filtering and attribution.
 * Call this in API routes after auth/body parsing to enable per-company,
 * per-agent error filtering in the Sentry dashboard.
 */
interface HiveTagsParams {
  company_id?: string;
  agent?: string;
  action_type?: string;
  backlog_id?: string;
  trigger?: string;
}

export function setHiveTags(params: HiveTagsParams) {
  // Only set tags that have values to avoid cluttering with undefined/null
  if (params.company_id) {
    Sentry.setTag("hive.company_id", params.company_id);
  }

  if (params.agent) {
    Sentry.setTag("hive.agent", params.agent);
  }

  if (params.action_type) {
    Sentry.setTag("hive.action_type", params.action_type);
  }

  if (params.backlog_id) {
    Sentry.setTag("hive.backlog_id", params.backlog_id);
  }

  if (params.trigger) {
    Sentry.setTag("hive.trigger", params.trigger);
  }
}