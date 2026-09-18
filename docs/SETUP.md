# Setup

About forty minutes end to end, most of it waiting for Google. Do it in this order —
each step needs the one before it.

---

## 1. The spreadsheet

Make a new Google Sheet. Call it something you will recognise in a year, like
**AMRL client tracker**.

Two tabs: **Clients** and **Errors**.

Paste this as row 1 of **Clients** (select A1, paste, it will spread across the columns):

```
Client ID	Submitted	Contact	Company	Email	Phone	Project type	Budget (GBP)	Deadline	Brief	Heard about us	Drive folder	Status	Payment	Deposit due	Paid (GBP)	Delivery	Delivered	Owner	Last updated	Notes
```

And this as row 1 of **Errors**:

```
When	Client ID	Step	Module	Attempts	Code	Message	What to do
```

Then: **View → Freeze → 1 row**, so the headers stay put when you scroll.

> **The column order is load-bearing.** The automation writes a row as a list of values in
> this exact order and updates the folder link by its column letter. Adding a column at
> the **end** is safe. Inserting one in the middle, or reordering, silently corrupts every
> row written afterwards. See [DATA-MODEL.md](DATA-MODEL.md).

Copy the spreadsheet ID out of the URL — the long string between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/1a2B3c4D5e6F7g8H9i0J_kLmNoPqRsTuVwXyZ/edit
                                       └──────────── this ────────────┘
```

## 2. The Drive folder

Make a folder in Drive called **Clients**. Everything the automation creates goes inside
it. Copy its ID from the URL:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                       └────────── this ─────────┘
```

## 3. The Google connection

### If you are using Make or n8n

Simplest path: connect with the Google account that owns the Sheet and the folder.

- **Make** — in any Google module, *Add* a connection, sign in, and allow the Sheets,
  Drive and Gmail scopes. One connection covers all three.
- **n8n** — Credentials → *Google OAuth2 API*, or the individual Sheets/Drive/Gmail
  credentials if you already have them.

Use a **shared studio account** rather than someone's personal login. When that person
leaves, or changes their password, an OAuth connection made under their account stops
working and the automation fails silently until someone notices.

### If you are running the reference implementation

That needs a service account, because there is no browser to click *Allow* in:

1. Google Cloud Console → new project → **Enable** the Sheets, Drive and Gmail APIs.
2. **IAM & Admin → Service Accounts** → create one → **Keys → Add key → JSON**.
3. Share the spreadsheet *and* the Clients folder with the service account's email
   address (it looks like `something@project.iam.gserviceaccount.com`), as **Editor**.
4. For Gmail only: **Workspace Admin → Security → API controls → Domain-wide delegation**.
   Add the service account's client ID with scope
   `https://www.googleapis.com/auth/gmail.send`.

> Gmail will not send as a service account — it has no mailbox. It has to impersonate a
> real one, which is what `GOOGLE_IMPERSONATE_SUBJECT` is for. This is the step everyone
> gets stuck on.

## 4. Import the scenario

### Make

1. **Scenarios → Create a new scenario → ⋯ → Import Blueprint**, and upload
   [`make/blueprint.json`](../make/blueprint.json).
2. Open **module 2, Settings**, and fill in the four values:
   - `spreadsheetId` — from step 1
   - `driveParentFolderId` — from step 2
   - `alertTo` — who gets the new-brief email
   - `roster` — comma-separated names, for assigning briefs
3. Open each Google and Gmail module and **pick your connection** from the dropdown.
   Imported blueprints never carry connections; you always re-select them.
4. Open **module 1** and copy the webhook URL.
5. Turn the scenario **ON**.

### n8n

1. **Workflows → Import from File**, and upload
   [`n8n/workflow.json`](../n8n/workflow.json).
2. Open the **Settings** node and fill in the same four values.
3. Open each Google and Gmail node and pick your credential.
4. Open **Form submission** and copy the Production webhook URL.
5. **Activate** the workflow.

## 5. Point your form at it

Any form that can POST JSON will do — Tally, Fillout, Typeform, a Webflow form, or plain
HTML. Send this shape:

```json
{
  "contactName": "Sasha Vance",
  "company": "Wilder & Co",
  "email": "sasha@wilderandco.example",
  "phone": "07700 900512",
  "projectType": "Social campaign",
  "budgetGbp": 6500,
  "deadline": "2026-11-20",
  "brief": "Launch campaign for the winter range…",
  "heardAbout": "Referral"
}
```

`phone` and `heardAbout` are optional. `projectType` must be one of: Brand film, Social
campaign, Photography, Website, Event coverage, Retainer.

## 6. Test it

Send one real submission with your own email in it. You should get, within a few seconds:

- a new row in **Clients**
- a folder in **Clients** on Drive, named `AMRL-0001 Your Company`, with four subfolders
- an email to your alert address, with the Drive link in it
- a `200` back, with the client ID

Then deliberately break it: rename the Drive folder and submit again. You should get the
row and an alert saying the folder step failed. Put the name back.

That second test is the one worth doing. It is how you find out the automation degrades
instead of collapsing — before it matters.

---

## Running the reference implementation locally

```bash
npm install
cp .env.example .env.local     # fill in what you have; everything is optional
npm run dev                    # http://localhost:3000
```

With no credentials it runs entirely in memory and says so in the header, which is how
the hosted demo works.

```bash
npm run verify     # typecheck, lint, 30 tests, and the workflow validator
npm run test:e2e   # 24 Playwright tests, desktop and mobile
```
