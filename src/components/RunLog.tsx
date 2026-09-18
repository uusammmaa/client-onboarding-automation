"use client";

import type { RunResult, StepLog } from "@/lib/pipeline/run";

/**
 * The run log.
 *
 * Make and n8n both show you an execution history; this is the same idea, rendered for
 * someone who does not have a Make login. Each row names the module it corresponds to,
 * so "module 5 failed" in the Make history and "Create the client folder failed" here
 * are visibly the same event.
 *
 * Retries are shown, not hidden. A step that succeeded on its second attempt is a
 * different fact from one that succeeded first time, and it is the fact that tells you
 * whether a rate limit is becoming a problem.
 */

const MARK = { ok: "✓", failed: "!", skipped: "–" } as const;

function Attempt({ attempt }: { attempt: StepLog["attempts"][number] }) {
  if (attempt.outcome === "ok") return null;
  return (
    <div className="attempt" data-outcome={attempt.outcome}>
      <strong>Attempt {attempt.attempt} — {attempt.code ?? "error"}</strong>
      <br />
      {attempt.detail}
      {attempt.waitedMs ? <> · waited {attempt.waitedMs} ms before trying again</> : null}
    </div>
  );
}

export function RunLog({ result }: { result: RunResult }) {
  const heading =
    result.outcome === "ok"
      ? "All seven steps ran"
      : result.outcome === "degraded"
        ? "Onboarded, but something needs a person"
        : "Nothing was saved";

  return (
    <>
      <div className="outcome" data-outcome={result.outcome}>
        <strong>{heading}.</strong> {result.message}
      </div>

      <div className="steps">
        {result.steps.map((step, index) => (
          <div
            key={step.stepId}
            className="step"
            data-status={step.status}
            style={{ animationDelay: `${index * 55}ms` }}
          >
            <span className="step__mark" aria-hidden="true">
              {MARK[step.status]}
            </span>
            <span className="step__label">
              {step.label}
              <span className="sr-only">
                {" "}
                — {step.status === "ok" ? "succeeded" : step.status === "failed" ? "failed" : "skipped"}
              </span>
              <br />
              <span className="step__module">{step.moduleRef}</span>
            </span>
            <span className="step__ms">{step.status === "skipped" ? "—" : `${step.durationMs} ms`}</span>

            {step.attempts
              .filter((attempt) => attempt.outcome === "ok")
              .map((attempt) => (
                <span className="step__detail" key={attempt.attempt}>
                  {attempt.detail}
                </span>
              ))}

            {step.status === "skipped" ? (
              <span className="step__detail">Skipped because an earlier step that matters failed.</span>
            ) : null}

            {step.attempts.map((attempt) => (
              <Attempt key={`${step.stepId}-${attempt.attempt}`} attempt={attempt} />
            ))}

            {step.remedy ? (
              <div className="remedy">
                <strong>What to do:</strong> {step.remedy}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
