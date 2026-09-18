"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fromRowValues, type ClientRecord, type Intake } from "@/lib/model";
import type { RunResult } from "@/lib/pipeline/run";
import type { FailureMode } from "@/lib/ports/memory";
import { SEED_ROWS } from "@/lib/demo-data";
import { rowStore } from "@/lib/row-store";
import { IntakeForm } from "./IntakeForm";
import { RunLog } from "./RunLog";
import { Ledger, Tracker } from "./Tracker";

/**
 * The onboarding desk.
 *
 * In demo mode the browser owns the tracker: it posts the rows it has, and the API
 * returns the updated set. That keeps the server stateless on serverless hosting and
 * means two people looking at the demo do not see each other's test submissions. With
 * Google credentials configured, the server reads the real spreadsheet and the browser's
 * copy is ignored.
 */

interface IntakeResponse {
  result: RunResult;
  mode: { sheets: string; drive: string; mail: string; live: boolean };
  rows: string[][];
  clients: ClientRecord[];
}

export function Desk() {
  // The rows are the source of truth; the records are derived from them, exactly as they
  // are when the real deployment reads them back out of the spreadsheet.
  const rows = useSyncExternalStore(rowStore.subscribe, rowStore.getSnapshot, rowStore.getServerSnapshot);
  const clients = useMemo<ClientRecord[]>(() => rows.filter((row) => row[0]).map(fromRowValues), [rows]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [mode, setMode] = useState<IntakeResponse["mode"] | null>(null);
  const [failureMode, setFailureMode] = useState<FailureMode>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { mode?: IntakeResponse["mode"] } | null) => {
        if (payload?.mode) setMode(payload.mode);
      })
      .catch(() => undefined);
  }, []);

  const submit = useCallback(
    async (intake: Intake) => {
      setBusy(true);
      setError(null);
      setResult(null);

      try {
        const response = await fetch("/api/intake", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intake, rows, failureMode }),
        });

        const payload = (await response.json()) as IntakeResponse & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `The request failed (${response.status})`);

        setResult(payload.result);
        setMode(payload.mode);
        rowStore.set(payload.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not reach the workflow.");
      } finally {
        setBusy(false);
      }
    },
    [failureMode, rows],
  );

  const reset = useCallback(() => {
    rowStore.reset();
    setResult(null);
    setError(null);
  }, []);

  return (
    <>
      <header className="top">
        <div className="top__inner">
          <span className="brand">AMRL Media</span>
          <span className="top__what">Client onboarding</span>
          <div className="mode">
            <span data-live={mode?.live}>Sheets: {label(mode?.sheets)}</span>
            <span data-live={mode?.live}>Drive: {label(mode?.drive)}</span>
            <span data-live={mode?.live}>Gmail: {label(mode?.mail)}</span>
          </div>
        </div>
      </header>

      <main className="shell">
        <Ledger clients={clients} />

        <div className="split">
          <IntakeForm busy={busy} failureMode={failureMode} onFailureModeChange={setFailureMode} onSubmit={submit} />

          <section className="card" aria-label="Run log" aria-live="polite">
            <div className="card__head">
              <h2 className="card__title">What the workflow did</h2>
              <span className="card__meta">{result ? `${result.durationMs} ms` : "waiting"}</span>
            </div>

            {error ? <div className="outcome" data-outcome="failed">{error}</div> : null}

            {result ? (
              <RunLog result={result} />
            ) : (
              <p className="empty">
                Send a brief and every step appears here: the Sheet row, the Drive folder, the alert email, and any
                retries along the way. Use <em>Break something on purpose</em> to watch the error handling work.
              </p>
            )}
          </section>
        </div>

        <section className="card" aria-label="Client tracker">
          <div className="card__head">
            <h2 className="card__title">The tracker</h2>
            <span className="card__meta">
              {clients.length} rows
              {rows !== SEED_ROWS ? (
                <button type="button" className="btn btn--quiet chip--inline" onClick={reset}>
                  Reset the demo
                </button>
              ) : null}
            </span>
          </div>
          <Tracker clients={clients} freshId={result?.record?.clientId} />
        </section>

        <footer className="foot">
          <p>
            This page is the reference implementation. The same seven steps ship as a{" "}
            <a href="https://github.com/uusammmaa/client-onboarding-automation/blob/main/make/blueprint.json">
              Make.com blueprint
            </a>{" "}
            and an{" "}
            <a href="https://github.com/uusammmaa/client-onboarding-automation/blob/main/n8n/workflow.json">
              n8n workflow
            </a>
            , with the handover notes in{" "}
            <a href="https://github.com/uusammmaa/client-onboarding-automation/tree/main/docs">docs</a>.
          </p>
          <ul>
            <li>Nothing here reaches a real Google account — no credentials are configured on this deployment.</li>
            <li>Your submissions stay in your browser. Reset the demo to clear them.</li>
          </ul>
        </footer>
      </main>
    </>
  );
}

function label(adapter: string | undefined): string {
  if (!adapter) return "—";
  return adapter === "in-memory" ? "demo" : adapter === "google" ? "live" : adapter;
}
