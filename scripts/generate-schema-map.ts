#!/usr/bin/env npx tsx
/**
 * Generates src/lib/schema-map.ts from schema.sql.
 *
 * Run: npx tsx scripts/generate-schema-map.ts
 *
 * This parses CREATE TABLE statements and extracts columns, types,
 * nullable flags, defaults, and CHECK constraints. The output is
 * used by Sentinel to detect schema drift at runtime.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SCHEMA_PATH = join(__dirname, "..", "schema.sql");
const OUTPUT_PATH = join(__dirname, "..", "src", "lib", "schema-map.ts");

interface ColumnDef {
  type: string;
  nullable: boolean;
  hasDefault: boolean;
}

interface CheckConstraint {
  column: string;
  allowedValues: string[];
}

interface TableDef {
  columns: Record<string, ColumnDef>;
  checks: CheckConstraint[];
}

function parseSchema(sql: string): Record<string, TableDef> {
  const tables: Record<string, TableDef> = {};

  // Match CREATE TABLE blocks (including UNLOGGED tables)
  const tableRegex = /CREATE\s+(?:UNLOGGED\s+)?TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\);/g;
  let match;

  while ((match = tableRegex.exec(sql)) !== null) {
    const tableName = match[1];
    // Strip SQL line comments before splitting — inline comments contain commas
    // that confuse the top-level comma splitter
    const body = match[2].replace(/--[^\n]*/g, "");
    const columns: Record<string, ColumnDef> = {};
    const checks: CheckConstraint[] = [];

    // Split by top-level commas (not inside parentheses)
    const lines = splitTopLevel(body);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip constraints that aren't column definitions
      if (/^(UNIQUE|PRIMARY KEY|FOREIGN KEY|CHECK|INDEX|CONSTRAINT)\b/i.test(trimmed)) {
        continue;
      }

      // Parse column: name TYPE [constraints...]
      const colMatch = trimmed.match(/^(\w+)\s+(\w+(?:\([^)]*\))?(?:\[\])?)/);
      if (!colMatch) continue;

      const colName = colMatch[1];
      const colType = colMatch[2].toUpperCase();

      // Skip SQL keywords that aren't column names
      if (["UNIQUE", "PRIMARY", "FOREIGN", "CHECK", "INDEX", "CONSTRAINT"].includes(colName.toUpperCase())) {
        continue;
      }

      const hasDefault = /DEFAULT\b/i.test(trimmed);
      const isNotNull = /NOT NULL/i.test(trimmed);
      const isPrimaryKey = /PRIMARY KEY/i.test(trimmed);

      columns[colName] = {
        type: colType,
        nullable: !isNotNull && !isPrimaryKey,
        hasDefault,
      };

      // Extract inline CHECK constraint with IN (...)
      const checkMatch = trimmed.match(/CHECK\s*\(\s*\w+\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
      if (checkMatch) {
        const values = checkMatch[1]
          .split(",")
          .map(v => v.trim().replace(/^'|'$/g, ""))
          .filter(v => v.length > 0);
        if (values.length > 0) {
          checks.push({ column: colName, allowedValues: values });
        }
      }
    }

    if (Object.keys(columns).length > 0) {
      tables[tableName] = { columns, checks };
    }
  }

  return tables;
}

function splitTopLevel(body: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of body) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      results.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) results.push(current);
  return results;
}

function generateOutput(tables: Record<string, TableDef>): string {
  const lines: string[] = [
    '/**',
    ' * Static schema map — single source of truth for Hive\'s Neon schema.',
    ' *',
    ' * Used by Sentinel to detect schema drift at runtime.',
    ' * Regenerate with: npx tsx scripts/generate-schema-map.ts',
    ' *',
    ' * Each table lists its columns with type and nullable flag.',
    ' * CHECK constraints on enum-like columns are also tracked so Sentinel',
    ' * can detect when code tries to insert a value the DB doesn\'t allow.',
    ' */',
    '',
    'export interface ColumnDef {',
    '  type: string;',
    '  nullable: boolean;',
    '  hasDefault: boolean;',
    '}',
    '',
    'export interface CheckConstraint {',
    '  column: string;',
    '  allowedValues: string[];',
    '}',
    '',
    'export interface TableDef {',
    '  columns: Record<string, ColumnDef>;',
    '  checks: CheckConstraint[];',
    '}',
    '',
    `export const SCHEMA_MAP: Record<string, TableDef> = ${JSON.stringify(tables, null, 2)};`,
    '',
    '/**',
    ' * Validate that a column exists on a table.',
    ' * Returns null if valid, or an error string if the column doesn\'t exist.',
    ' */',
    'export function validateColumn(table: string, column: string): string | null {',
    '  const tableDef = SCHEMA_MAP[table];',
    '  if (!tableDef) return `Table \'${table}\' not in schema map`;',
    '  if (!tableDef.columns[column]) return `Column \'${table}.${column}\' does not exist. Available: ${Object.keys(tableDef.columns).join(", ")}`;',
    '  return null;',
    '}',
    '',
    '/**',
    ' * Validate that a value is allowed by a CHECK constraint.',
    ' * Returns null if valid (or no check exists), or an error string.',
    ' */',
    'export function validateCheckValue(table: string, column: string, value: string): string | null {',
    '  const tableDef = SCHEMA_MAP[table];',
    '  if (!tableDef) return null;',
    '  const check = tableDef.checks.find(c => c.column === column);',
    '  if (!check) return null;',
    '  if (!check.allowedValues.includes(value)) {',
    '    return `Value \'${value}\' not allowed for ${table}.${column}. Allowed: ${check.allowedValues.join(", ")}`;',
    '  }',
    '  return null;',
    '}',
    '',
    '/**',
    ' * Get all expected tables and their column counts.',
    ' * Used by Sentinel to compare against live DB.',
    ' */',
    'export function getExpectedTables(): Array<{ table: string; columnCount: number }> {',
    '  return Object.entries(SCHEMA_MAP).map(([table, def]) => ({',
    '    table,',
    '    columnCount: Object.keys(def.columns).length,',
    '  }));',
    '}',
    '',
  ];

  return lines.join('\n');
}

// Main
const sql = readFileSync(SCHEMA_PATH, "utf-8");
const tables = parseSchema(sql);

console.log(`Parsed ${Object.keys(tables).length} tables from schema.sql:`);
for (const [name, def] of Object.entries(tables)) {
  console.log(`  ${name}: ${Object.keys(def.columns).length} columns, ${def.checks.length} checks`);
}

const output = generateOutput(tables);
writeFileSync(OUTPUT_PATH, output);
console.log(`\nSchema map written to: src/lib/schema-map.ts`);
