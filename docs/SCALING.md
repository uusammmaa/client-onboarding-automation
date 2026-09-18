# Scaling

The brief asked for a V1 and said not to overcomplicate it. This is what to do **later**,
roughly in the order it becomes worth doing — and, just as importantly, the signal that
tells you it is time.

Do not do any of this now. A workflow built for problems you do not have yet is harder to
edit and no more useful.

---

## Now: how to extend it without breaking it

**Add a field to the form.** Add the column at the **end** of the Clients tab, then add
the value at the end of module ⑥'s mapping. Never insert a column in the middle —
[DATA-MODEL.md](DATA-MODEL.md) explains why.

**Change the folder structure.** Edit the four subfolder module names, or duplicate one
for a fifth. In n8n it is a list in the *List the subfolders* node.

**Change who gets alerted.** Module ②, `alertTo`. Comma-separate for several people.

**Change the deposit terms.** Module ②, `depositAmount` and `depositDue`.

**Route by project type.** Add a router after ⑤ and send different project types to
different alert addresses. About five minutes.

---

## When two briefs a day becomes ten

### Deduplicate submissions

**Signal:** duplicate rows appearing after someone double-clicks.

Add a Sheets *search rows* before module ⑥, filtering on the same email within the last
ten minutes. If there is a hit, respond `200` with the existing client ID and stop. One
extra module, and it makes the webhook idempotent — which matters more once you have
retries in front of it.

### Auto-chase the deposit

**Signal:** someone is manually checking who has not paid.

A second scheduled scenario, daily at 9am: read the Clients tab, filter to
`Payment = Awaiting deposit` and `Deposit due < today`, set the row to `Overdue` and email
the client. Fifteen minutes to build, and it is the highest-value automation after this
one.

### Weekly digest

**Signal:** the Monday meeting starts with "where are we on everything?".

Scheduled scenario, Monday 8am: read the tab, group by status, email the studio. What is
overdue, what is waiting on the client, what is due this week.

---

## When the Sheet starts creaking

### Move the tracker to Airtable

**Signal:** more than one person edits it at once and they overwrite each other, or you
want views per person, or attachments on a record.

Airtable gives you real field types, per-view filters, and a proper API. The scenario
changes shape very little — swap the Sheets modules for Airtable modules. Keep the Sheet
as a read-only mirror for a month if anyone has built spreadsheets on top of it.

### Or move it to a database

**Signal:** you want to ask questions the Sheet cannot answer — revenue by project type
per quarter, average time from enquiry to delivery.

At that point the tracker is an application, not a spreadsheet, and the honest move is
Postgres with a small admin UI. That is a different project, not an evolution of this one.

---

## When it is the business, not a convenience

### Make the webhook idempotent properly

**Signal:** you have retries, queues, or more than one system posting to it.

Have the form send a stable `submissionId` (most form tools can). Store it on the row.
Module ④ looks it up; if it is already there, return the existing client ID. This is
strictly better than the email-plus-time-window version, because it is exact.

### Stop the ID race

**Signal:** you turn off sequential processing to get throughput, and two clients get the
same ID.

Reading "highest ID" and writing a row are not atomic. Options, in order of effort:

1. Keep Make's **sequential processing** on. Simplest, and fine up to a brief a minute.
2. Move the counter to a single cell and use a **locking pattern**. Fiddly in Make.
3. Move the tracker somewhere with a real sequence — Airtable autonumber, or a database.

Do not solve this before you have it. Sequential processing is the right answer for a
studio.

### Split the scenario

**Signal:** runs take long enough that the form times out.

Respond to the webhook immediately after module ⑥, and move ⑦–⑬ into a second scenario
triggered off the new row. The client gets their confirmation in under a second, and the
slow parts happen behind it.

This is worth the complexity only once the wait is visible to a client.

---

## What not to do

**Do not automate the status columns.** Status, Payment and Delivery encode judgement —
whether the work is really "in production", whether a part-payment counts as "invoiced".
Automating them means encoding that judgement, and it will be wrong in exactly the cases
that matter.

**Do not add a CRM yet.** A tracker with under a couple of hundred clients and one
pipeline does not need one. You will spend more time maintaining the integration than the
Sheet costs you.

**Do not put the brief text through an LLM to "summarise and tag" it.** Tempting, and the
brief is four sentences. Read it.

**Do not add Slack as well as email.** Pick one place alerts go. Two means people stop
reading both.
