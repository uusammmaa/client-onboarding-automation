# Client onboarding automation

A clean V1 onboarding workflow for a small studio. A form becomes a tracker row, a Drive
folder, an alert email, and a line on the books.

**[Send a brief →](https://client-onboarding-automation.vercel.app)** — then use
*Break something on purpose* and watch the error handling work.

```
form ──▶ ① webhook ──▶ ② settings ──▶ ③ router ──┬─ invalid ──▶ 400, nothing written
                                                  │
                                                  └─ valid ──▶ ④ read tracker
                                                               ⑤ assign ID
                                                               ⑥ add row       ← the one that matters
                                                               ⑦ create folder
                                                               ⑧–⑪ subfolders
                                                               ⑫ write folder link
                                                               ⑬ email the studio
                                                               ⑭ 200 to the form
```

---

## What you get

| | |
|---|---|
| [`make/blueprint.json`](make/blueprint.json) | Importable Make.com scenario, fourteen modules, error handler on every fallible one |
| [`n8n/workflow.json`](n8n/workflow.json) | The same flow for n8n, with the explanation on sticky notes inside the canvas |
| This app | A working reference implementation. Same seven steps, same error policy, tested |
| [`docs/`](docs) | Setup, module-by-module walkthrough, data model, error handling, scaling, handover |

The exports and the implementation cannot drift, because
[`scripts/validate-workflows.ts`](scripts/validate-workflows.ts) fails CI if they do.

---

## The one decision everything follows from

**The tracker row is the thing worth protecting. Everything after it is convenience.**

A client with a row and no Drive folder is a five-second fix. A client with a folder and
no row is invisible until they ring up asking why nobody has been in touch.

So the workflow splits at module ⑥:

| | If it fails | Why |
|---|---|---|
| Up to and including the row | **Stop.** Write nothing, tell the client to try again | Nothing was written, so that is honest and safe |
| After the row | **Carry on.** Log it, alert the studio, still confirm to the client | The client is onboarded; the rest can be finished by hand |

That is the whole error policy. Every retry rule, every handler and every alert is a
consequence of it.

---

## Simple on purpose

The brief said *simple, reliable, no unnecessary tools*. Things deliberately left out:

- **No database.** The Sheet is the system of record, and it is the right size for it.
- **No queue.** Make's sequential processing and dead-letter queue already do the job.
- **No status automation.** Status, Payment and Delivery encode judgement. Automating
  them means encoding that judgement, and it will be wrong in the cases that matter.
- **Four explicit subfolder modules, not a loop.** Less elegant; far easier for a
  non-developer to read and edit, which was the actual requirement.

[SCALING.md](docs/SCALING.md) says what to add later and, more usefully, the signal that
tells you it is time.

---

## Retries that mean something

Transient failures back off exponentially. Permanent ones do not retry at all — retrying
a 403 "sheet not shared" for forty seconds before failing is a bad trade.

Google's `403` is the one that catches people out: it means both *slow down* and *you are
not allowed*, and only the `reason` field distinguishes them. The adapter checks the
reason, not just the status.

| Failure | What happens |
|---|---|
| Sheets 429 rate limit | Backs off, retries, succeeds |
| Sheet not shared (403) | Fails at once, writes nothing, says *"Share the tracker spreadsheet with the automation's service account as an Editor"* |
| Drive quota | Retries, then gives up. The row survives |
| Drive folder missing (404) | No retry. Says *"Check DRIVE_CLIENTS_FOLDER_ID. The folder may have been moved to the bin or renamed"* |
| Gmail token expired | The client is onboarded; only the internal alert is lost |

Every failure lands on an **Errors** tab with a *What to do* column. An error log that
only records what broke makes whoever finds it go and ask someone.

---

## Break something on purpose

A client reading "simple error handling" in a proposal has no way to tell whether it
works. The demo has a dropdown that injects a real failure into a port, and the run log
shows every attempt, every backoff, and what a human should do about it:

```
✓ Add a row to the tracker            Module 4 · Google Sheets → Add a row      0 ms
  Row 7 in Clients

! Create the client folder            Module 5 · Google Drive → Create a folder 0 ms
  Attempt 1 — drive.parentMissing
  Google Drive returned 404: parent folder not found
  What to do: Check DRIVE_CLIENTS_FOLDER_ID. The folder may have been moved to
  the bin or renamed.
```

---

## The tracker

Twenty-one columns, twelve written by the automation and nine maintained by the studio.
The ledger at the top answers the only question anyone actually opens it for: what is on
the books, what has been collected, what is outstanding, and who is overdue.

Column order is load-bearing — the row is written positionally and the folder link is
addressed by column letter. Adding a column at the **end** is safe; inserting one in the
middle silently corrupts every row written afterwards.
[DATA-MODEL.md](docs/DATA-MODEL.md) spells it out, and there is a test asserting the
folder column is still `L`.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:3000 — no credentials needed
npm run verify     # typecheck, lint, 30 tests, workflow validator
npm run test:e2e   # 24 Playwright tests, desktop and mobile
```

Every credential in [`.env.example`](.env.example) is optional. With none, everything runs
in memory and the header says so. Add Google service-account credentials and the same code
writes to a real spreadsheet, a real Drive folder and a real mailbox.

---

## Verification

```
30 unit tests          validation, retries, degradation, idempotency, the data model
24 Playwright tests    desktop + Pixel 7
workflow validator     unreachable nodes, missing error routes, committed credentials, parity
```

The validator earned its place on the first run: it caught four missing error routes and
one flaw in its own rule.

---

## Documentation

| | |
|---|---|
| [SETUP.md](docs/SETUP.md) | Forty minutes, in order. Including the Gmail impersonation step everyone gets stuck on |
| [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | Module by module, and what the studio does next |
| [DATA-MODEL.md](docs/DATA-MODEL.md) | The columns, and why the order matters |
| [ERROR-HANDLING.md](docs/ERROR-HANDLING.md) | The five failures that actually happen, and their fixes |
| [SCALING.md](docs/SCALING.md) | What to build next, when — and what not to build |
| [HANDOVER.md](docs/HANDOVER.md) | For whoever owns this after today |

---

Built by [Usama Akram](https://github.com/uusammmaa). MIT licensed.
