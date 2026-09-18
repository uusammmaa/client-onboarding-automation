# How it works

One pass, module by module. Roughly one second end to end when nothing is wrong.

```
form ──▶ ① webhook ──▶ ② settings ──▶ ③ router ──┬─ invalid ──▶ 400, nothing written
                                                  │
                                                  └─ valid ──▶ ④ read tracker
                                                               ⑤ assign ID
                                                               ⑥ add row          ← the one that matters
                                                               ⑦ create folder
                                                               ⑧–⑪ subfolders
                                                               ⑫ write folder link
                                                               ⑬ email the studio
                                                               ⑭ 200 to the form
```

---

## ① Form submission — webhook

Receives the JSON from your form. Nothing else happens here; Make replies only when
module ⑭ runs, which is why the form waits for a real answer rather than a "received".

## ② Settings — set variables

The only module you edit. Four values: spreadsheet ID, Drive folder ID, alert address,
roster. Everything downstream reads from here, so pointing the scenario at a different
account is one module, not fourteen.

It also computes three things once, so they are consistent across the run:
`submittedAt`, `depositDue` (seven days out) and `depositAmount` (half the budget).

## ③ Is it usable? — router

Two routes. The top one runs if the submission has a name, a company, a valid email, a
budget of at least £500 and a brief of at least twenty characters. Anything else falls to
the bottom route, which returns `400` with the reasons.

**Nothing has been written at this point**, which is why the rejection can safely say
"try again" — there is no half-created client to clean up.

Your form should catch all of this first. This is the backstop for when it does not, or
when someone posts to the webhook directly.

## ④ Read the tracker — Google Sheets, search rows

Reads the Clients tab so ⑤ can work out the next ID. Retries three times if Sheets is
rate-limiting.

## ⑤ Assign a client ID

Takes the **highest existing ID** and adds one — not the row count. If someone deletes a
row by hand, the row count goes down and the next client would reuse an ID that is
already on an invoice. Reading the maximum avoids that.

Also picks the owner, round-robin across the roster by project type. A brief with nobody's
name on it sits unanswered; this is deliberately crude and works.

## ⑥ Add row to tracker — Google Sheets, add a row

**This is the step that matters.** Everything else is convenience. If this fails the
scenario stops, the form gets an error, and the client is told to try again — because
nothing was written, that is safe.

Retries three times with a five-second gap, then parks the run in Make's dead-letter
queue, where you can retry it by hand once the problem is fixed.

Two details worth knowing:

- **Value input is RAW, not USER_ENTERED.** A brief starting with `=` or `+` would
  otherwise be interpreted as a formula. Wrong, and a spreadsheet-injection risk.
- The row is written positionally, in the column order from
  [DATA-MODEL.md](DATA-MODEL.md).

## ⑦ Create client folder — Google Drive

Creates `AMRL-0001 Company Name` under your Clients folder. Characters Drive dislikes
(`\ / : * ? " < > |`) are replaced with hyphens.

**Not fatal.** The error handler lets the scenario continue with an empty folder link. A
client with a row and no folder takes five seconds to fix; a client with a folder and no
row is invisible.

## ⑧–⑪ Subfolders — Google Drive ×4

```
AMRL-0001 Company Name/
  01 Brief and contract
  02 Assets from client
  03 Work in progress
  04 Final delivery
```

Four separate modules rather than a loop. Less elegant, far easier to read and edit —
which is what was asked for. Each is skipped if ⑦ produced no folder.

To change the structure, edit the four names, or duplicate a module for a fifth. In the
n8n version it is a list in one node.

## ⑫ Write the folder link — Google Sheets, update a row

Puts the Drive URL into column **L** of the row ⑥ created, so the Sheet is the only place
anyone has to look. Skipped if there is no link.

## ⑬ Email the studio — Gmail

One plain-text email with everything needed to pick the brief up: client ID, project,
budget, the deposit figure and when it is due, the deadline, the owner, contact details,
the brief itself and the folder link.

**Reply-To is the client**, so hitting reply answers them rather than the studio. Small
thing, saves a copy-paste every time.

If the folder step failed, the email says `not created — see the Errors tab` rather than
leaving a blank. Not fatal: if Gmail is down the client is still onboarded, and the
failure lands on the Errors tab.

## ⑭ Confirm to the client — webhook response

`200`, with the client ID. Your form shows the thank-you.

The client is told the same thing whether or not ⑦–⑬ worked, because from their side the
brief did arrive. What failed is internal.

---

## What the studio does next

The automation stops at "a brief arrived and someone owns it". The rest is three columns
in the Sheet, updated by hand:

| Column | Move it when |
|---|---|
| **Status** | New enquiry → Onboarding → In production → Delivered → Closed |
| **Payment** | Awaiting deposit → Deposit paid → Invoiced → Paid in full (or Overdue) |
| **Delivery** | Not started → In progress → With client for review → Delivered |

That is deliberate. Automating status changes means automating the judgement behind them,
and V1 does not need that. [SCALING.md](SCALING.md) covers what to automate first when it
does.

## Where things go wrong

| You see | It means |
|---|---|
| Row appears, folder does not | Drive permissions, or the Clients folder was moved or renamed. Check the Errors tab |
| Nothing at all, form shows an error | The Sheet is not shared with the connection, or the ID in Settings is wrong |
| Everything works but no email | Gmail connection expired. Common after a password change |
| A `400` back from the form | The submission failed validation. The response lists the fields |
| Two rows for one submission | The form posted twice. Add a guard on the form, or see SCALING.md on idempotency |

Full version with fixes: [ERROR-HANDLING.md](ERROR-HANDLING.md).
