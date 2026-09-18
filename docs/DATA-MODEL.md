# Data model

## The Clients tab

Twenty-one columns. The automation writes A–U on every new row; the studio maintains the
highlighted ones by hand.

| Col | Header | Written by | Notes |
|-----|--------|-----------|-------|
| A | Client ID | automation | `AMRL-0001`. Sequential, zero-padded so it sorts |
| B | Submitted | automation | ISO 8601 UTC |
| C | Contact | automation | As typed |
| D | Company | automation | As typed |
| E | Email | automation | Lowercased and trimmed |
| F | Phone | automation | Blank if not given |
| G | Project type | automation | One of the six options |
| H | Budget (GBP) | automation | Whole pounds, no symbol |
| I | Deadline | automation | `YYYY-MM-DD` |
| J | Brief | automation | Free text |
| K | Heard about us | automation | Blank if not given |
| **L** | **Drive folder** | automation | Written by module ⑫, *after* the row exists |
| M | Status | **studio** | New enquiry · Onboarding · In production · Delivered · Closed · Lost |
| N | Payment | **studio** | Awaiting deposit · Deposit paid · Invoiced · Paid in full · Overdue |
| O | Deposit due | automation | Submitted + 7 days |
| P | Paid (GBP) | **studio** | Running total received |
| Q | Delivery | **studio** | Not started · In progress · With client for review · Delivered |
| R | Delivered | **studio** | Date the final files went out |
| S | Owner | automation | Round-robin by project type; change it freely |
| T | Last updated | automation, then studio | Set on creation |
| U | Notes | **studio** | Anything |

### Why the order matters

Module ⑥ writes a row as a **positional list of values**, and module ⑫ updates the folder
link by **column letter** (`L`). Both break silently if the order changes.

- **Adding a column at the end (V onward):** safe. The automation ignores it.
- **Inserting a column in the middle:** every row written afterwards has its data shifted
  one column right, and the folder link lands in the wrong place. Nothing errors.
- **Reordering or deleting:** same.

If you must restructure, update the column order in module ⑥'s mapping and the column
letter in module ⑫ at the same time. In the reference implementation both come from one
list in `src/lib/model.ts`, and there is a test asserting the folder column is `L`.

### Useful things to add yourself

None of these affect the automation:

- **Conditional formatting** on N: red for `Overdue`, green for `Paid in full`.
- **Data validation** dropdowns on M, N and Q, from the values above. Stops typos, which
  matter because the totals are computed by matching on these strings.
- A **Balance** column: `=H2-P2`.
- A **Days overdue** column: `=IF(AND(N2<>"Paid in full", TODAY()>O2), TODAY()-O2, "")`.

## The Errors tab

| Col | Header | Notes |
|-----|--------|-------|
| A | When | ISO 8601 UTC |
| B | Client ID | Which client was affected |
| C | Step | Human name, e.g. *Create the client folder* |
| D | Module | Which module in the scenario |
| E | Attempts | How many times it tried before giving up |
| F | Code | `drive.rateLimit`, `sheets.forbidden`, `gmail.unauthorised`… |
| G | Message | What Google said |
| H | What to do | The fix, in words |

Column H is the point. An error log that only records what broke makes whoever finds it
go and ask someone. Recording the remedy alongside it means they can just fix it.

Nothing prunes this tab. Clear it out when it gets long — nothing reads from it.

## Derived values

Three things computed rather than stored, so a change takes effect everywhere at once:

| Value | Rule | Where |
|---|---|---|
| Deposit amount | 50% of budget | `DEPOSIT_TERMS.fraction` |
| Deposit due | Submitted + 7 days | `DEPOSIT_TERMS.dueInDays` |
| Folder name | `{Client ID} {Company}`, Drive-unsafe characters replaced | `folderName()` |

Change the terms in one place and the email, the Sheet and the demo all follow.

## Identifiers

`AMRL-0001`, not a UUID, because these get read out on the phone and typed into invoices.

The next number is the **highest existing ID plus one**, not the row count. If somebody
deletes row 4, the row count drops and a UUID-free scheme based on it would hand
`AMRL-0004` to a second client — while the first one's invoice still says `AMRL-0004`.
Reading the maximum avoids that. It is why module ④ exists at all.

The prefix is configurable, so a second brand or a second office can share the same
spreadsheet without colliding.

## What is deliberately not modelled

- **Invoices and line items.** The tracker records a budget and a running total paid. If
  you need itemised invoicing, that belongs in accounting software with a link on the row.
- **Multiple contacts per client.** One contact per brief. A second brief from the same
  company is a second row, which is correct — they are different jobs.
- **File-level tracking.** The folder link is enough. Drive already knows what is in it.
- **History.** The Sheet holds current state, not an audit trail. Sheets' own version
  history covers "who changed this and when" well enough at this size.
