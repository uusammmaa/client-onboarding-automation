# Error handling

## The one rule

**The tracker row is the thing worth protecting. Everything after it is convenience.**

A client with a row and no Drive folder is a five-second fix. A client with a folder and
no row is invisible until they ring up asking why nobody has been in touch. So the
scenario is split at module ⑥:

| Modules | If they fail | Why |
|---|---|---|
| ①–⑥, up to and including the row | **Stop.** Return an error. Write nothing | Nothing has been written, so "please try again" is honest and safe |
| ⑦–⑬, after the row | **Carry on.** Log it, alert someone | The client is onboarded; the rest can be finished by hand |

Everything below follows from that.

## Transient or permanent

Retrying costs time. Retrying something that will never succeed costs time *and* still
fails, so the distinction matters.

**Transient — retry with backoff:**
- `429` rate limited
- `500`, `502`, `503`, `504` — Google having a moment
- `403` **only when** the reason is `rateLimitExceeded`, `userRateLimitExceeded`,
  `quotaExceeded` or `backendError`

**Permanent — fail immediately:**
- `400` — the request is wrong; it will be wrong next time too
- `401` — credentials expired
- `403` for any other reason — usually "not shared with this account"
- `404` — the spreadsheet or folder is not there

> Google's `403` is the one that catches people out. It means both "slow down" and "you
> are not allowed", and only the `reason` field distinguishes them. Retrying a genuine
> permission error for forty seconds before failing is a bad trade, so the adapter checks
> the reason rather than the status alone.

Backoff is exponential — 400ms, 800ms, 1600ms. A rate limit that just rejected you will
reject you again a hundred milliseconds later.

## In Make

Each fallible module has an error handler attached:

- **`Break` with retry** on module ⑥ (the tracker row). Retries three times at five-second
  intervals, then parks the whole run in the **dead-letter queue**. You retry it from
  there once the problem is fixed, and nothing is lost in the meantime.
- **`Resume`** on modules ⑦–⑫. Hands back an empty value so the scenario carries on.
- **Log and continue** on ⑬: writes to the Errors tab, then continues.

Turn the dead-letter queue on in the scenario settings. Without it, a parked run is just a
failed run.

## In n8n

Same policy, different levers:

- `retryOnFail: true`, `maxTries: 3`, `waitBetweenTries: 2000` on every Google node.
- `onError: continueErrorOutput` on **Create client folder** and **Email the studio** —
  failures leave by the second output and land on the error branch.
- **Add row to tracker** has no `onError`, so a failure stops the execution. That is
  deliberate, and there is a check in `scripts/validate-workflows.ts` that fails CI if
  somebody adds one.
- The error branch logs to the Errors tab, emails the studio, and still returns `200` to
  the form.

## What the studio sees

Three things happen on a failure, in this order:

1. **A row on the Errors tab**, with the step, the code, the message and *what to do*.
2. **An email to the alert address**, saying which client and which step, and that the
   tracker row is safe.
3. **The client still gets a `200`.** Their brief did arrive. What failed is internal, and
   telling them about it would only make them resubmit and create a duplicate.

Point 3 is a judgement call. It is right because every failure after module ⑥ is
recoverable by hand, and the studio has been told.

## The five failures that actually happen

### "Sheet not shared" — `403`

The connection cannot edit the spreadsheet. Usually after someone made a copy and the
copy did not inherit sharing.

**Fix:** share the spreadsheet with the connected account, or the service account email,
as Editor. Then retry the parked run.

### "Parent folder not found" — `404`

The Clients folder was renamed, moved or binned.

**Fix:** check `driveParentFolderId` in module ② against the folder's URL. Restore it from
the bin if that is where it went.

### "Invalid credentials" — `401` on Gmail

OAuth tokens expire when the account's password changes, or when a Workspace admin
revokes app access. Everything else keeps working, because only Gmail uses that
connection — which is why this looks like "no emails, but the Sheet is fine".

**Fix:** reconnect the Gmail connection. Consider a shared studio account rather than a
personal one, so this does not happen every time someone changes their password.

### "Rate limit exceeded" — `429`

Sheets allows 60 write requests per minute per user. One submission uses two or three.
You will only hit this if something is bulk-importing at the same time.

**Fix:** none needed — the retry handles it. If it happens repeatedly, something else is
hammering the same account.

### Two rows for one submission

Not a failure, a double-submit. The form posted twice, or somebody hit refresh on the
thank-you page.

**Fix:** disable the submit button on click. If it keeps happening, see the idempotency
section in [SCALING.md](SCALING.md) — a lookup on email plus a short time window before
module ⑥ costs one more module and stops it properly.

## Checking it still works

Twice a year, do this. It takes ten minutes and it is the only way to know the error
handling has not quietly rotted:

1. Rename the Clients folder in Drive. Submit a brief.
   Expect: row created, Errors tab entry, alert email, `200` to the form.
2. Put the name back. Submit again. Expect: everything green.
3. Un-share the spreadsheet from the connection. Submit.
   Expect: `400`-ish error to the form, **no row**, run parked in the dead-letter queue.
4. Re-share. Retry the parked run from the queue. Expect: it completes.

The demo has a **Break something on purpose** dropdown that runs exactly these, without
touching a real Google account.

## What is not handled

Worth saying plainly:

- **Partial Drive writes.** If two of four subfolders are created and then Drive fails,
  the two stay. Harmless; the next run reuses the existing folder rather than duplicating.
- **Concurrent submissions.** Two briefs arriving in the same second can read the same
  "highest ID" and both claim it. The Make scenario is set to sequential processing, which
  prevents it. If you turn that off for throughput, read the idempotency section in
  SCALING.md first.
- **Sheet row limits.** Google caps a spreadsheet at 10 million cells. At 21 columns that
  is comfortably past the point where you should be using a database.
