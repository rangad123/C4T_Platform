/**
 * Liveness and readiness.
 *
 * - GET /healthz: the process answers. Nothing else is looked at, so a busy database never makes an orchestrator restart a healthy process.
 * - GET /readyz: the platform can do its work: the database takes a write lock, its migrations match this code, a worker said it was alive
 *   recently, the data folder's disk has room, and the process is not shutting down. The answer names failing checks only by their short
 *   names (`database`, `migrations`, `worker`, `disk`, `shutdown`): no paths, versions, numbers or secrets, because it needs no key.
 */
import fs from "node:fs";
import type { Db } from "../db.js";
import { knownSchemaVersion } from "../db.js";
import { readHeartbeat } from "./heartbeat.js";

export type CheckName = "database" | "migrations" | "worker" | "disk" | "shutdown";

export interface ReadinessInput {
    db: Db;
    dataDir: string;
    minFreeBytes: number;
    workerStaleMs: number;
    shuttingDown: boolean;
    now?: number;
    /** Free bytes of the data folder's disk (tests pass their own; default fs.statfs). */
    freeBytes?: (dir: string) => number | undefined;
}

export interface Readiness {
    ready: boolean;
    failing: CheckName[];
}

export function diskFreeBytes(dir: string): number | undefined {
    try {
        const s = fs.statfsSync(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return undefined;
    }
}

/** The database can take its write lock (nothing is written: the transaction is rolled back at once). */
export function databaseWritable(db: Db): boolean {
    try {
        db.raw.exec("BEGIN IMMEDIATE");
        db.raw.exec("ROLLBACK");
        return true;
    } catch {
        return false;
    }
}

export function schemaVersion(db: Db): number | undefined {
    try {
        return (db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_version")?.v ?? undefined) || undefined;
    } catch {
        return undefined;
    }
}

export function checkReadiness(input: ReadinessInput): Readiness {
    const failing: CheckName[] = [];
    if (input.shuttingDown) failing.push("shutdown");
    if (!databaseWritable(input.db)) failing.push("database");
    const v = schemaVersion(input.db);
    if (v === undefined || v < knownSchemaVersion()) failing.push("migrations");
    const beat = readHeartbeat(input.db);
    if (beat === undefined || (input.now ?? Date.now()) - beat > input.workerStaleMs) failing.push("worker");
    const free = (input.freeBytes ?? diskFreeBytes)(input.dataDir);
    if (input.minFreeBytes > 0 && (free === undefined || free < input.minFreeBytes)) failing.push("disk");
    return { ready: failing.length === 0, failing };
}
