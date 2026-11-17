/**
 * Writes src/platform/pg/baseline.sql (scripts/pg-baseline-render.ts) from a fresh SQLite database. Run it after adding a migration
 * slot: `npx tsx scripts/pg-baseline.ts`, then read the diff. Things the file already has keep their place, so a new slot's tables and
 * columns show up as additions. Do not edit the file by hand: tests/pg-baseline-unit.test.ts fails unless it equals this output.
 */
import fs from "node:fs";
import path from "node:path";
import { knownSchemaVersion } from "../src/platform/db.js";
import { renderBaseline } from "./pg-baseline-render.js";

const file = path.resolve(import.meta.dirname, "../src/platform/pg/baseline.sql");
const sql = renderBaseline(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
fs.writeFileSync(file, sql);
console.log(`Wrote ${file}: ${(sql.match(/^CREATE TABLE /gm) ?? []).length} tables, schema version ${knownSchemaVersion()}.`);
