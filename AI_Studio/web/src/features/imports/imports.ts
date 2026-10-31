/** Shapes of the Maestro import answer (see src/platform/routes/imports.ts). */
export interface MaestroFlowReport {
    file: string;
    status: "converted" | "skipped";
    reason?: string;
    title?: string;
    kind?: "mobile" | "web";
    convertedSteps: number;
    checks: number;
    notes: Array<{ step: number; command: string; level: "skipped" | "adjusted"; reason: string }>;
    variables: Array<{ name: string; placeholder: string }>;
}

export interface ImportAnswer {
    dryRun: boolean;
    jobId: string | null;
    imported: Array<{ file: string; id?: string; testId?: string; title?: string; kind?: string }>;
    skipped: Array<{ file: string; reason: string }>;
    reports: MaestroFlowReport[];
}
