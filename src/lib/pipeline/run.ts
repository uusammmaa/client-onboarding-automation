import { SHEET_COLUMNS, type ClientRecord, type Intake } from "../model";
import { StepError, type DrivePort, type MailPort, type SheetsPort } from "../ports";
import { DEFAULT_CONFIG, STEPS, type Step, type StepContext, type WorkflowConfig } from "./steps";

/**
 * The executor.
 *
 * Make and n8n both give you per-module error handling and a retry directive. This is the
 * same policy, written down where it can be tested:
 *
 *   - transient failure  → back off and try again, up to the step's limit
 *   - permanent failure  → stop trying immediately
 *   - fatal step failed  → stop the run, and tell the client their brief did not arrive
 *   - non-fatal failed   → carry on, log it, and alert someone who can finish it by hand
 *
 * The last line is the one that matters in practice. Most of the value of this workflow
 * is the row in the Sheet. A Drive or Gmail outage should degrade the onboarding, not
 * cancel it.
 */

export interface AttemptLog {
  attempt: number;
  at: string;
  outcome: "ok" | "retrying" | "failed";
  detail: string;
  code?: string;
  waitedMs?: number;
}

export interface StepLog {
  stepId: string;
  moduleRef: string;
  label: string;
  describes: string;
  status: "ok" | "failed" | "skipped";
  fatal: boolean;
  durationMs: number;
  attempts: AttemptLog[];
  /** What a human should do, when something went wrong. */
  remedy?: string;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** ok = everything ran. degraded = the client is onboarded but something needs a human. */
  outcome: "ok" | "degraded" | "failed";
  record?: ClientRecord;
  rowNumber?: number;
  steps: StepLog[];
  /** Plain-English summary, shown to whoever submitted the form. */
  message: string;
  /** Problems a human has to act on. */
  followUps: Array<{ step: string; problem: string; remedy?: string }>;
}

export interface RunOptions {
  intake: Intake;
  sheets: SheetsPort;
  drive: DrivePort;
  mail: MailPort;
  config?: Partial<WorkflowConfig>;
  now?: () => Date;
  /** Base backoff in ms. Zero in tests, so the suite is not a sleep. */
  backoffMs?: number;
  steps?: Step[];
}

const DEFAULT_BACKOFF_MS = 400;

export async function runWorkflow(options: RunOptions): Promise<RunResult> {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const now = options.now ?? (() => new Date());
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const steps = options.steps ?? STEPS;
  const startedAt = now();

  const context: StepContext = {
    intake: options.intake,
    record: {} as ClientRecord,
    config,
    sheets: options.sheets,
    drive: options.drive,
    mail: options.mail,
    now,
  };

  const logs: StepLog[] = [];
  const followUps: RunResult["followUps"] = [];
  let aborted = false;

  for (const step of steps) {
    if (aborted) {
      logs.push({
        stepId: step.id,
        moduleRef: step.moduleRef,
        label: step.label,
        describes: step.describes,
        status: "skipped",
        fatal: step.fatal,
        durationMs: 0,
        attempts: [],
      });
      continue;
    }

    const started = Date.now();
    const attempts: AttemptLog[] = [];
    let status: StepLog["status"] = "failed";
    let remedy: string | undefined;

    for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
      try {
        const detail = await step.run(context);
        attempts.push({ attempt, at: now().toISOString(), outcome: "ok", detail });
        status = "ok";
        break;
      } catch (error) {
        const stepError = asStepError(error);
        const canRetry = stepError.retryable && attempt < step.maxAttempts;

        attempts.push({
          attempt,
          at: now().toISOString(),
          outcome: canRetry ? "retrying" : "failed",
          detail: stepError.message,
          code: stepError.code,
          // Exponential, because a rate limit that just rejected you will reject you
          // again a hundred milliseconds later.
          waitedMs: canRetry ? backoffMs * 2 ** (attempt - 1) : undefined,
        });

        if (!canRetry) {
          remedy = stepError.remedy;
          followUps.push({ step: step.label, problem: stepError.message, remedy: stepError.remedy });
          if (step.fatal) aborted = true;
          break;
        }

        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }

    logs.push({
      stepId: step.id,
      moduleRef: step.moduleRef,
      label: step.label,
      describes: step.describes,
      status,
      fatal: step.fatal,
      durationMs: Date.now() - started,
      attempts,
      remedy,
    });
  }

  const finishedAt = now();
  const failed = logs.some((log) => log.status === "failed" && log.fatal);
  const degraded = !failed && logs.some((log) => log.status === "failed");
  const outcome: RunResult["outcome"] = failed ? "failed" : degraded ? "degraded" : "ok";

  // A failed run has already been logged to the Errors tab below; do that before
  // returning so the tab is the same in every deployment.
  if (outcome !== "ok") {
    await logErrors(options.sheets, config, logs, context.record?.clientId ?? "unknown", now).catch(() => undefined);
  }

  return {
    runId: `run_${startedAt.getTime().toString(36)}`,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    outcome,
    record: context.record?.clientId ? context.record : undefined,
    rowNumber: context.rowNumber,
    steps: logs,
    message: summarise(outcome, context.record, followUps),
    followUps,
  };
}

function summarise(
  outcome: RunResult["outcome"],
  record: ClientRecord | undefined,
  followUps: RunResult["followUps"],
): string {
  if (outcome === "ok") {
    return `${record?.company ?? "The client"} is onboarded as ${record?.clientId}. ${record?.owner} has it, and the studio has been emailed.`;
  }
  if (outcome === "degraded") {
    const parts = followUps.map((f) => f.step.toLowerCase()).join(" and ");
    return `${record?.company ?? "The client"} is on the tracker as ${record?.clientId}, but ${parts} did not complete. Someone needs to finish that by hand.`;
  }
  return `The brief was not saved. ${followUps[0]?.problem ?? "Something went wrong."} Nothing was written, so it is safe to submit again once it is fixed.`;
}

/**
 * Append failures to the Errors tab.
 *
 * Deliberately best-effort: if the Sheet is the thing that is broken, this will fail too,
 * and an error handler that throws is worse than one that does nothing.
 */
async function logErrors(
  sheets: SheetsPort,
  config: WorkflowConfig,
  logs: StepLog[],
  clientId: string,
  now: () => Date,
): Promise<void> {
  const header = ["When", "Client ID", "Step", "Module", "Attempts", "Code", "Message", "What to do"];
  await sheets.ensureTab(config.spreadsheetId, config.errorsTab, header);

  for (const log of logs) {
    if (log.status !== "failed") continue;
    const last = log.attempts[log.attempts.length - 1];
    await sheets.appendRow(config.spreadsheetId, config.errorsTab, [
      now().toISOString(),
      clientId,
      log.label,
      log.moduleRef,
      String(log.attempts.length),
      last?.code ?? "",
      last?.detail ?? "",
      log.remedy ?? "",
    ]);
  }
}

function asStepError(error: unknown): StepError {
  if (error instanceof StepError) return error;
  // Anything unrecognised is treated as permanent. Retrying an unknown failure three
  // times usually just produces the same unknown failure three times.
  return new StepError(error instanceof Error ? error.message : String(error), {
    retryable: false,
    code: "unknown",
    remedy: "Not a failure the workflow recognises. Check the run log in Make or n8n.",
  });
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export const CLIENTS_HEADER = SHEET_COLUMNS.map((column) => column.header);
