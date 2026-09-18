# Handover

For whoever owns this after today. You do not need to be a developer to run it.

---

## What you have

| | |
|---|---|
| **A Make scenario** (or n8n workflow) | Fourteen modules. Runs on every form submission |
| **A Google Sheet** | `Clients` and `Errors`. This is the system of record |
| **A Drive folder** | `Clients`, one subfolder per client |
| **A Gmail connection** | Sends the new-brief alert |
| **This repository** | The blueprint, the workflow, the docs, and a working copy you can run locally |

## The five-minute version

A brief arrives → it gets a row, a folder and an ID → someone is assigned → the studio
gets an email.

If something after the row fails, the client is still onboarded and you get told what to
fix. If the row itself fails, nothing is written and the client is asked to try again.

## Who needs access to what

| Thing | Who | Note |
|---|---|---|
| Make / n8n account | Whoever owns the automation | Not a personal login |
| The Google account the connection uses | Same | **Use a shared studio account** |
| The Sheet | Everyone who tracks work | Editor |
| The Drive folder | Everyone | Editor |
| The alert address | Whoever picks up new briefs | A group, not one person |

> The single most common way this breaks: the automation is connected to somebody's
> personal Google account, they change their password or leave, and everything stops
> silently. Move it to a shared account now, not later.

## Monthly, five minutes

1. Open the **Errors** tab. If there are rows since last time, column H says what to do.
2. Skim the Make/n8n run history for failures that did not make it to the Errors tab.
3. Check the Clients tab for rows with an empty **Drive folder** column — those are
   onboardings that half-completed.

## Twice a year, ten minutes

Test the failure path, following the checklist in
[ERROR-HANDLING.md](ERROR-HANDLING.md#checking-it-still-works). It is the only way to find
out the error handling has rotted before it matters.

Also worth doing after anyone changes the Sheet structure.

## The things most likely to break

| Symptom | Cause | Fix |
|---|---|---|
| Nothing happens at all | Scenario switched off | Turn it on |
| Rows stop appearing | Sheet un-shared, or ID changed | Re-share; check module ② |
| No emails, everything else fine | Gmail connection expired | Reconnect it |
| Folders stop being created | Clients folder moved or renamed | Check module ② |
| Data in the wrong columns | Someone inserted a column in the Sheet | See DATA-MODEL.md |

The last one is the nasty one, because nothing errors — it just silently writes the wrong
data from that point on. If you need a new column, **add it at the end**.

## Changing things safely

**Safe on your own:** alert address, roster, deposit terms, subfolder names, adding a
column at the end of the Sheet.

**Worth asking someone first:** reordering columns, changing the client ID format,
splitting the scenario, adding a second scenario that writes to the same Sheet.

Whatever you change, **send one test brief afterwards** with your own email in it. Sixty
seconds, and it catches almost everything.

## If you want to understand it properly

Read them in this order:

1. [HOW-IT-WORKS.md](HOW-IT-WORKS.md) — module by module
2. [DATA-MODEL.md](DATA-MODEL.md) — the columns, and why the order matters
3. [ERROR-HANDLING.md](ERROR-HANDLING.md) — what happens when Google has a bad day
4. [SCALING.md](SCALING.md) — what to build next, and when

Or open the [live demo](https://client-onboarding-automation.vercel.app), send a brief,
and watch the run log. Then use **Break something on purpose** and watch it fail properly.
That is faster than reading anything.

## If you want to change the code

```bash
npm install
npm run dev        # http://localhost:3000, no credentials needed
npm run verify     # typecheck, lint, 30 tests, workflow validator
```

The validator is the one to know about. It checks that the Make blueprint and the n8n
workflow still match each other and the seven steps, that every fallible module still has
an error route, and that nobody has committed a real spreadsheet ID over the placeholder.
It runs on every pull request.

## Getting help

Open an issue on the repository with:

- what you did
- what you expected
- the run ID from the Make/n8n history, or the row from the Errors tab

The run history keeps the full input and output of every module, which is almost always
enough to see what went wrong without touching anything.
