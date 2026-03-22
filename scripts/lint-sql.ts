/**
 * SQL Linter — validates table/column references in sql`` tagged template literals
 * against the static schema map.
 *
 * Usage: npx tsx scripts/lint-sql.ts
 *
 * Exits 0 if clean, 1 if errors found.
 */

import { SCHEMA_MAP, validateColumn } from "../src/lib/schema-map";
import { readFileSync, readdirSync } from "fs";
import path from "path";

// ─── Configuration ───────────────────────────────────────────────────

const SRC_DIRS = ["src/app/api/", "src/lib/"];

const SQL_FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "coalesce", "now", "greatest", "least",
  "row_to_json", "json_agg", "json_build_object", "jsonb_build_object",
  "array_agg", "string_agg", "bool_or", "bool_and",
  "current_date", "current_timestamp", "current_time",
  "upper", "lower", "trim", "length", "substring", "replace", "concat",
  "extract", "date_trunc", "date_part", "to_char", "to_date", "to_timestamp",
  "generate_series", "unnest", "array_length",
  "row_number", "rank", "dense_rank", "lag", "lead",
  "abs", "ceil", "floor", "round", "trunc", "random",
  "gen_random_uuid", "uuid_generate_v4",
  "exists", "not_exists",
  "any", "all", "some",
  "position", "strpos", "overlay", "left", "right",
  "nullif", "pg_typeof",
]);

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "join", "left", "right", "inner", "outer", "cross",
  "on", "and", "or", "not", "in", "is", "null", "true", "false",
  "as", "asc", "desc", "order", "by", "group", "having", "limit", "offset",
  "distinct", "case", "when", "then", "end", "else",
  "insert", "into", "values", "update", "set", "delete",
  "returning", "with", "recursive",
  "like", "ilike", "between", "exists", "any", "all",
  "interval", "filter", "over", "partition", "within",
  "union", "intersect", "except",
  "create", "table", "if", "primary", "key", "default", "references",
  "cascade", "restrict", "no", "action",
  "begin", "commit", "rollback", "transaction",
  "index", "unique", "check", "constraint", "foreign",
  "alter", "add", "drop", "column", "type", "using",
  "lateral", "only", "do", "nothing", "conflict",
  "for", "each", "row", "trigger", "before", "after",
  "text", "integer", "boolean", "jsonb", "json", "date", "timestamptz",
  "timestamp", "numeric", "serial", "bigserial", "bigint", "smallint",
  "varchar", "char", "real", "double", "precision", "bytea",
  "array", "of",
]);

// Skip columns that look like these patterns
const SKIP_COLUMN_PATTERNS = [
  /^\d+$/,              // pure numbers
  /^'.*'$/,             // string literals
  /^\$\{/,              // template interpolations
  /^\*/,                // wildcard
  /^->>?/,              // JSON operators
  /^::/,                // type cast
];

// PostgreSQL type names used in casts (::type)
const PG_TYPES = new Set([
  "float", "int", "integer", "bigint", "smallint", "real", "double",
  "numeric", "decimal", "text", "varchar", "char", "boolean", "bool",
  "json", "jsonb", "date", "timestamp", "timestamptz", "interval",
  "uuid", "bytea", "inet", "cidr", "macaddr", "money",
]);

// ─── Types ───────────────────────────────────────────────────────────

interface SqlError {
  file: string;
  line: number;
  query: string;
  table: string;
  column: string;
  message: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractSqlQueries(content: string): Array<{ query: string; lineOffset: number }> {
  const results: Array<{ query: string; lineOffset: number }> = [];

  // Find all sql` occurrences and extract the full template literal
  let searchPos = 0;
  while (searchPos < content.length) {
    const idx = content.indexOf("sql`", searchPos);
    if (idx === -1) break;

    // Make sure 'sql' is preceded by a word boundary (not part of a longer identifier)
    if (idx > 0 && /\w/.test(content[idx - 1])) {
      searchPos = idx + 4;
      continue;
    }

    const startPos = idx + 4; // position after sql`
    const lineOffset = content.slice(0, idx).split("\n").length - 1;

    const { text, endPos } = extractTemplateBody(content, startPos);
    if (endPos > startPos) {
      results.push({ query: text, lineOffset });
      searchPos = endPos;
    } else {
      searchPos = startPos;
    }
  }

  return results;
}

function extractTemplateBody(content: string, start: number): { text: string; endPos: number } {
  let result = "";
  let i = start;

  while (i < content.length) {
    // Skip ${...} interpolations (handles nested template literals, strings, braces)
    if (content[i] === "$" && content[i + 1] === "{") {
      i = skipInterpolation(content, i + 2);
      result += " __INTERPOLATION__ ";
      continue;
    }
    // Closing backtick — end of the sql`` template
    if (content[i] === "`") {
      return { text: result, endPos: i + 1 };
    }
    result += content[i];
    i++;
  }

  // Unterminated template literal
  return { text: result, endPos: i };
}

function skipInterpolation(content: string, start: number): number {
  let i = start;
  let braceDepth = 1;

  while (i < content.length && braceDepth > 0) {
    const ch = content[i];

    if (ch === "`") {
      // Nested template literal — skip it entirely
      i++;
      while (i < content.length && content[i] !== "`") {
        if (content[i] === "$" && content[i + 1] === "{") {
          i = skipInterpolation(content, i + 2);
          continue;
        }
        if (content[i] === "\\") i++; // skip escape
        i++;
      }
      if (i < content.length) i++; // skip closing backtick
      continue;
    }

    if (ch === "'" || ch === '"') {
      // Skip string literal
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
      if (i < content.length) i++; // skip closing quote
      continue;
    }

    if (ch === "/" && content[i + 1] === "/") {
      // Skip single-line comment
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }

    if (ch === "{") { braceDepth++; i++; continue; }
    if (ch === "}") { braceDepth--; if (braceDepth > 0) i++; else i++; continue; }

    i++;
  }

  return i;
}


function extractCTENames(query: string): Set<string> {
  // Extract CTE names from WITH ... AS (...) patterns
  const cteNames = new Set<string>();

  // Only process queries that start with WITH
  if (!/^\s*WITH\b/i.test(query)) return cteNames;

  // Extract individual CTE names from "name AS (" patterns across the entire query
  // CTE definitions look like: WITH name1 AS (...), name2 AS (...)
  const namePattern = /\b(\w+)\s+AS\s*\(/gi;
  let nameMatch;
  while ((nameMatch = namePattern.exec(query)) !== null) {
    const name = nameMatch[1].toLowerCase();
    // Skip SQL keywords that can appear before AS (
    if (!SQL_KEYWORDS.has(name) && !SQL_FUNCTIONS.has(name)) {
      cteNames.add(name);
    }
  }
  return cteNames;
}

function extractTableReferences(query: string): Map<string, string> {
  // Returns alias -> table name map
  const aliasMap = new Map<string, string>();

  // Normalize whitespace
  const normalized = query
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim();

  const tableNames = new Set(Object.keys(SCHEMA_MAP));
  const cteNames = extractCTENames(query);

  // Match FROM/JOIN/INSERT INTO/UPDATE/DELETE FROM table [alias]
  const tablePatterns = [
    /\bFROM\s+(\w+)(?:\s+(\w+))?/gi,
    /\bJOIN\s+(\w+)(?:\s+(\w+))?/gi,
    /\bINSERT\s+INTO\s+(\w+)/gi,
    /\bUPDATE\s+(\w+)(?:\s+(\w+))?/gi,
    /\bDELETE\s+FROM\s+(\w+)(?:\s+(\w+))?/gi,
  ];

  for (const pattern of tablePatterns) {
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const table = match[1].toLowerCase();
      const alias = match[2]?.toLowerCase();

      // Skip CTE references (they're virtual tables, not real ones)
      if (cteNames.has(table)) {
        // Register the CTE alias so we skip alias.column validation for it
        if (alias && !SQL_KEYWORDS.has(alias)) {
          aliasMap.set(alias, "__cte__");
        }
        aliasMap.set(table, "__cte__");
        continue;
      }

      if (!tableNames.has(table)) continue;
      if (table === "information_schema") continue;

      // Register table under its own name
      aliasMap.set(table, table);

      // Register alias if present and not a keyword
      if (alias && !SQL_KEYWORDS.has(alias) && !SQL_FUNCTIONS.has(alias) && alias !== "on" && alias !== "set" && alias !== "where") {
        aliasMap.set(alias, table);
      }
    }
  }

  return aliasMap;
}

function extractColumnAliases(query: string): Set<string> {
  // Extract aliases defined by AS keyword: "expression AS alias"
  // Also handles: "COUNT(*) as cnt", "SUM(x) as total", etc.
  const aliases = new Set<string>();
  const asPattern = /\bAS\s+(\w+)\b/gi;
  let match;
  while ((match = asPattern.exec(query)) !== null) {
    aliases.add(match[1].toLowerCase());
  }
  return aliases;
}

function extractColumnReferences(query: string, aliasMap: Map<string, string>): Array<{ table: string; column: string }> {
  const refs: Array<{ table: string; column: string }> = [];
  const seen = new Set<string>(); // deduplicate

  // Extract alias.column patterns (e.g., c.slug, m.mrr, aa.status)
  const qualifiedPattern = /\b(\w+)\.(\w+)\b/g;
  let match;

  while ((match = qualifiedPattern.exec(query)) !== null) {
    const prefix = match[1].toLowerCase();
    const column = match[2].toLowerCase();

    // Skip EXCLUDED.* (upsert references)
    if (prefix === "excluded") continue;

    // Skip if prefix is not a known alias/table
    if (!aliasMap.has(prefix)) continue;

    // Skip SQL functions
    if (SQL_FUNCTIONS.has(column)) continue;

    // Skip if column matches skip patterns
    if (SKIP_COLUMN_PATTERNS.some((p) => p.test(column))) continue;

    // Skip * wildcard
    if (column === "*") continue;

    const table = aliasMap.get(prefix)!;
    // Skip CTE references
    if (table === "__cte__") continue;
    const key = `${table}.${column}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ table, column });
    }
  }

  // For single-table queries, validate bare column names too
  // Filter out CTE entries from alias map to determine real table count
  const realTables = new Map([...aliasMap].filter(([, v]) => v !== "__cte__"));
  if (realTables.size === 1) {
    const tableName = [...realTables.values()][0];
    const columnAliases = extractColumnAliases(query);
    const allKnownColumns = new Set(
      Object.values(SCHEMA_MAP).flatMap((t) => Object.keys(t.columns))
    );

    // Remove interpolations, string literals, and comments for cleaner parsing
    const cleaned = query
      .replace(/__INTERPOLATION__/g, " ")
      .replace(/'[^']*'/g, " ")
      .replace(/--[^\n]*/g, " ");

    // Extract tokens: word-boundary tokens that aren't preceded by a dot (would be alias.col)
    // and aren't followed by a ( (would be a function call)
    const barePattern = /(?<!\.)(\b[a-zA-Z_]\w*\b)(?!\s*\()/g;
    let tokenMatch;
    while ((tokenMatch = barePattern.exec(cleaned)) !== null) {
      const token = tokenMatch[1].toLowerCase();

      // Skip if preceded by a dot (qualified ref — already handled above)
      const charBefore = cleaned[tokenMatch.index - 1];
      if (charBefore === ".") continue;

      // Skip SQL keywords, functions, type names, table names
      if (SQL_KEYWORDS.has(token)) continue;
      if (SQL_FUNCTIONS.has(token)) continue;
      if (PG_TYPES.has(token)) continue;
      if (SCHEMA_MAP[token]) continue; // table name itself

      // Skip EXCLUDED (upsert reference)
      if (token === "excluded") continue;

      // Skip CTE names
      const cteNames = extractCTENames(cleaned);
      if (cteNames.has(token)) continue;

      // Skip column aliases (e.g., COUNT(*) AS cnt — don't validate cnt)
      if (columnAliases.has(token)) continue;

      // Skip tokens that are aliases in our alias map
      if (aliasMap.has(token) && token !== tableName) continue;

      // Only flag if it looks like a plausible column name:
      // it must exist in SOME table's schema (so it looks column-like)
      // but NOT in this table; OR it's in an INSERT column list for this table
      if (allKnownColumns.has(token) || looksLikeColumn(token, tableName) || isInInsertColumnList(cleaned, token, tableName) || isInSelectColumnList(cleaned, token) || isInClausePosition(cleaned, token)) {
        const key = `${tableName}.${token}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({ table: tableName, column: token });
        }
      }
    }
  }

  return refs;
}

/** Check if a token appears in an INSERT INTO table (...) column list */
function isInInsertColumnList(query: string, token: string, tableName: string): boolean {
  const insertPattern = new RegExp(
    `INSERT\\s+INTO\\s+${tableName}\\s*\\(([^)]+)\\)`,
    "i"
  );
  const match = query.match(insertPattern);
  if (!match) return false;
  const columnList = match[1].split(",").map(c => c.trim().toLowerCase());
  return columnList.includes(token);
}

/** Check if a token appears in a SELECT column list (bare, no alias) */
function isInSelectColumnList(query: string, token: string): boolean {
  // Match SELECT ... FROM and check if token is in the column list
  const selectPattern = /\bSELECT\s+([\s\S]*?)\bFROM\b/i;
  const match = query.match(selectPattern);
  if (!match) return false;
  // Split by comma and look for bare token (not aliased, not function call)
  const parts = match[1].split(",").map(p => p.trim().toLowerCase());
  return parts.some(p => p === token);
}

/** Check if a token is used in a WHERE, SET, ORDER BY, or GROUP BY clause context */
function isInClausePosition(query: string, token: string): boolean {
  // Look for patterns like: WHERE token, AND token, OR token, SET token =, ORDER BY token
  const patterns = [
    new RegExp(`\\bWHERE\\s+.*\\b${token}\\b`, "is"),
    new RegExp(`\\bAND\\s+[^,]*\\b${token}\\b`, "is"),
    new RegExp(`\\bOR\\s+[^,]*\\b${token}\\b`, "is"),
    new RegExp(`\\bSET\\s+.*\\b${token}\\b`, "is"),
    new RegExp(`\\bORDER\\s+BY\\s+.*\\b${token}\\b`, "is"),
    new RegExp(`\\bGROUP\\s+BY\\s+.*\\b${token}\\b`, "is"),
    new RegExp(`\\bON\\s+.*\\b${token}\\b`, "is"),
  ];
  return patterns.some(p => p.test(query));
}

/** Heuristic: does this token look like a column reference in context of the given table? */
function looksLikeColumn(token: string, _tableName: string): boolean {
  // Tokens ending in common column suffixes are likely columns
  const columnSuffixes = [
    "_id", "_at", "_count", "_type", "_url", "_key", "_name", "_slug",
    "_status", "_rate", "_score", "_text", "_note", "_data", "_json",
    "_date", "_number", "_version", "_token", "_handle", "_email",
    "_companies", "_agents", "_entries", "_issues",
  ];
  // Tokens containing underscores that look like snake_case identifiers
  if (token.includes("_")) {
    for (const suffix of columnSuffixes) {
      if (token.endsWith(suffix)) return true;
    }
    // Any snake_case token is likely a column reference in SQL context
    return true;
  }
  return false;
}

function shouldSkipQuery(query: string): boolean {
  const lower = query.toLowerCase().trim();

  // Skip information_schema queries
  if (lower.includes("information_schema")) return true;

  // Skip CREATE TABLE IF NOT EXISTS (DDL)
  if (lower.match(/\bcreate\s+table\b/)) return true;

  // Skip ALTER TABLE (DDL)
  if (lower.match(/\balter\s+table\b/)) return true;

  // Skip empty or very short queries
  if (lower.replace(/\s/g, "").length < 10) return true;

  return false;
}

function isSubqueryAlias(query: string, alias: string): boolean {
  // Check if alias is used for a subquery: (...) as alias or (...) alias
  const pattern = new RegExp(`\\)\\s+(?:as\\s+)?${alias}\\b`, "i");
  return pattern.test(query);
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  const rootDir = path.resolve(__dirname, "..");
  const errors: SqlError[] = [];

  // Collect all .ts files recursively
  const files: string[] = [];
  for (const dir of SRC_DIRS) {
    const fullDir = path.join(rootDir, dir);
    try {
      const entries = readdirSync(fullDir, { recursive: true, withFileTypes: false }) as string[];
      for (const entry of entries) {
        if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
          files.push(path.join(fullDir, entry));
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  console.log(`Scanning ${files.length} TypeScript files for SQL queries...`);

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf-8");
    const relPath = path.relative(rootDir, filePath);

    // Quick check: does this file use sql` at all?
    if (!content.includes("sql`")) continue;

    const queries = extractSqlQueries(content);

    for (const { query, lineOffset } of queries) {
      if (shouldSkipQuery(query)) continue;

      const aliasMap = extractTableReferences(query);
      if (aliasMap.size === 0) continue; // No recognized tables

      // Filter out subquery aliases
      for (const [alias] of aliasMap) {
        if (isSubqueryAlias(query, alias)) {
          aliasMap.delete(alias);
        }
      }

      const columnRefs = extractColumnReferences(query, aliasMap);

      for (const { table, column } of columnRefs) {
        const error = validateColumn(table, column);
        if (error) {
          errors.push({
            file: relPath,
            line: lineOffset + 1, // 1-indexed
            query: query.trim().slice(0, 120).replace(/\s+/g, " "),
            table,
            column,
            message: error,
          });
        }
      }
    }
  }

  // Print results
  if (errors.length === 0) {
    console.log("\nAll SQL queries valid against schema map.");
    process.exit(0);
  }

  console.log(`\n${errors.length} SQL error(s) found:\n`);
  for (const err of errors) {
    console.log(`  ${err.file}:${err.line}`);
    console.log(`    ${err.message}`);
    console.log(`    Query: ${err.query}...`);
    console.log();
  }

  process.exit(1);
}

main();
