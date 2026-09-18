import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkflow, CLIENTS_HEADER } from "@/lib/pipeline/run";
import { DEFAULT_CONFIG, STEPS, readTracker } from "@/lib/pipeline/steps";
import { FailureInjector, MemoryDrive, MemoryMail, MemorySheets, type InjectionState } from "@/lib/ports/memory";
import { StepError } from "@/lib/ports";
import { SEED_ROWS } from "@/lib/demo-data";
import { columnLetter, depositDueDate, folderName, formatClientId, fromRowValues, intakeSchema, toRowValues, type Intake } from "@/lib/model";

const NOW = new Date("2026-09-19T10:00:00.000Z");

const VALID: Intake = {
  contactName: "Sasha Vance",
  company: "Wilder & Co",
  email: "sasha@wilderandco.example",
  phone: "07700 900512",
  projectType: "Social campaign",
  budgetGbp: 6500,
  deadline: "2026-11-20",
  brief: "Launch campaign for the winter range, ten to twelve assets plus a hero cut for paid.",
  heardAbout: "Referral",
  marketingConsent: true,
};

function harness(options: { failure?: InjectionState } = {}) {
  const injector = new FailureInjector(options.failure ?? { mode: "none", failFirstNAttempts: 1 });
  const sheets = new MemorySheets(injector);
  sheets.seed(DEFAULT_CONFIG.spreadsheetId, DEFAULT_CONFIG.clientsTab, CLIENTS_HEADER, SEED_ROWS);
  const drive = new MemoryDrive(injector);
  const mail = new MemoryMail(injector);
  return { sheets, drive, mail, injector };
}

function run(intake: Intake, harnessed: ReturnType<typeof harness>) {
  return runWorkflow({
    intake,
    sheets: harnessed.sheets,
    drive: harnessed.drive,
    mail: harnessed.mail,
    now: () => NOW,
    // Zero backoff: the suite should not be a sleep.
    backoffMs: 0,
  });
}

describe("the happy path", () => {
  it("runs all seven steps and onboards the client", async () => {
    const h = harness();
    const result = await run(VALID, h);

    expect(result.outcome).toBe("ok");
    expect(result.steps).toHaveLength(STEPS.length);
    expect(result.steps.every((step) => step.status === "ok")).toBe(true);
    expect(result.record?.clientId).toBe("AMRL-0006");
    expect(result.followUps).toEqual([]);
  });

  it("writes the row before it creates the folder", async () => {
    const h = harness();
    const result = await run(VALID, h);

    const order = result.steps.map((step) => step.stepId);
    expect(order.indexOf("append-row")).toBeLessThan(order.indexOf("create-folder"));
  });

  it("puts every field on the row in the right column", async () => {
    const h = harness();
    await run(VALID, h);

    const clients = await readTracker(h.sheets, DEFAULT_CONFIG);
    const created = clients.at(-1)!;
    expect(created.company).toBe("Wilder & Co");
    expect(created.budgetGbp).toBe(6500);
    expect(created.status).toBe("New enquiry");
    expect(created.paymentStatus).toBe("Awaiting deposit");
    expect(created.depositDue).toBe("2026-09-26");
    expect(created.driveFolderUrl).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\//);
  });

  it("creates the client folder and all four subfolders", async () => {
    const h = harness();
    await run(VALID, h);

    const names = h.drive.all().map((folder) => folder.name);
    expect(names).toContain("AMRL-0006 Wilder & Co");
    expect(names).toContain("01 Brief and contract");
    expect(names).toContain("04 Final delivery");
    expect(names).toHaveLength(5);
  });

  it("emails the studio with the client as the reply-to", async () => {
    const h = harness();
    await run(VALID, h);

    const email = h.mail.sent[0];
    expect(email?.to).toEqual(DEFAULT_CONFIG.alertTo);
    expect(email?.replyTo).toBe("sasha@wilderandco.example");
    expect(email?.subject).toContain("Wilder & Co");
    // The deposit figure is the thing accounts will look for.
    expect(email?.body).toContain("£3,250");
    expect(email?.body).toContain("AMRL-0006");
  });

  it("takes the next id from the highest one present, not the row count", async () => {
    const h = harness();
    // A deleted row must not cause the next client to reuse an id that is on an invoice.
    h.sheets.seed(DEFAULT_CONFIG.spreadsheetId, DEFAULT_CONFIG.clientsTab, CLIENTS_HEADER, [
      SEED_ROWS[0]!,
      SEED_ROWS[4]!,
    ]);

    const result = await run(VALID, h);
    expect(result.record?.clientId).toBe("AMRL-0006");
  });
});

describe("validation", () => {
  it.each([
    ["a missing name", { contactName: "" }],
    ["a bad email", { email: "not-an-email" }],
    ["a non-UK phone", { phone: "+1 415 555 0100" }],
    ["a budget below the minimum", { budgetGbp: 100 }],
    ["a one-word brief", { brief: "help" }],
  ])("rejects %s and writes nothing", async (_label, override) => {
    const h = harness();
    const result = await run({ ...VALID, ...override } as Intake, h);

    expect(result.outcome).toBe("failed");
    expect(result.steps[0]?.status).toBe("failed");
    // Nothing downstream should have run at all.
    expect(result.steps.slice(1).every((step) => step.status === "skipped")).toBe(true);

    const clients = await readTracker(h.sheets, DEFAULT_CONFIG);
    expect(clients).toHaveLength(SEED_ROWS.length);
    expect(h.drive.all()).toHaveLength(0);
    expect(h.mail.sent).toHaveLength(0);
  });

  it("tells the client it is safe to try again", async () => {
    const h = harness();
    const result = await run({ ...VALID, email: "nope" } as Intake, h);
    expect(result.message).toMatch(/safe to submit again/i);
  });

  it("accepts a submission with no phone and no source", async () => {
    const h = harness();
    const result = await run({ ...VALID, phone: "", heardAbout: undefined }, h);
    expect(result.outcome).toBe("ok");
  });
});

describe("transient failures", () => {
  it("retries a rate-limited Sheets write and succeeds", async () => {
    const h = harness({ failure: { mode: "sheets_rate_limit", failFirstNAttempts: 1 } });
    const result = await run(VALID, h);

    expect(result.outcome).toBe("ok");
    // The injector fires on the first write, which is the row append.
    const step = result.steps.find((s) => s.stepId === "append-row")!;
    expect(step.attempts.length).toBeGreaterThan(1);
    expect(step.attempts[0]?.outcome).toBe("retrying");
    expect(step.status).toBe("ok");
  });

  it("backs off further on each attempt", async () => {
    const h = harness({ failure: { mode: "drive_quota", failFirstNAttempts: 2 } });
    const result = await runWorkflow({
      intake: VALID,
      sheets: h.sheets,
      drive: h.drive,
      mail: h.mail,
      now: () => NOW,
      backoffMs: 1,
    });

    const folder = result.steps.find((step) => step.stepId === "create-folder")!;
    const waits = folder.attempts.map((attempt) => attempt.waitedMs).filter((value): value is number => value !== undefined);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
  });

  it("does not retry a permission error", async () => {
    const h = harness({ failure: { mode: "drive_permission", failFirstNAttempts: 99 } });
    const result = await run(VALID, h);

    const folder = result.steps.find((step) => step.stepId === "create-folder")!;
    expect(folder.attempts).toHaveLength(1);
    expect(folder.attempts[0]?.outcome).toBe("failed");
  });
});

describe("degradation", () => {
  it("keeps the client when Drive is down", async () => {
    const h = harness({ failure: { mode: "drive_quota", failFirstNAttempts: 99 } });
    const result = await run(VALID, h);

    expect(result.outcome).toBe("degraded");
    expect(result.record?.clientId).toBe("AMRL-0006");

    const clients = await readTracker(h.sheets, DEFAULT_CONFIG);
    expect(clients.at(-1)?.company).toBe("Wilder & Co");
    // The studio is still told, so somebody can pick the brief up.
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]?.body).toMatch(/not created/);
  });

  it("keeps the client when Gmail is down", async () => {
    const h = harness({ failure: { mode: "gmail_auth", failFirstNAttempts: 99 } });
    const result = await run(VALID, h);

    expect(result.outcome).toBe("degraded");
    const clients = await readTracker(h.sheets, DEFAULT_CONFIG);
    expect(clients.at(-1)?.driveFolderUrl).toBeTruthy();
    expect(result.followUps[0]?.remedy).toMatch(/Reconnect the Gmail account/);
  });

  it("stops everything when the tracker row cannot be written", async () => {
    const h = harness({ failure: { mode: "sheets_permission", failFirstNAttempts: 99 } });
    const result = await run(VALID, h);

    expect(result.outcome).toBe("failed");
    expect(h.drive.all()).toHaveLength(0);
    expect(h.mail.sent).toHaveLength(0);
    expect(result.followUps[0]?.remedy).toMatch(/Share the tracker spreadsheet/);
  });

  it("records every failure on the Errors tab", async () => {
    const h = harness({ failure: { mode: "drive_quota", failFirstNAttempts: 99 } });
    await run(VALID, h);

    const errors = await h.sheets.readRows(DEFAULT_CONFIG.spreadsheetId, DEFAULT_CONFIG.errorsTab);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.[2]).toBe("Create the client folder");
    expect(errors[0]?.[7]).toMatch(/clears itself|hammering/);
  });

  it("never claims success when something needs a person", async () => {
    const h = harness({ failure: { mode: "gmail_bounce", failFirstNAttempts: 99 } });
    const result = await run(VALID, h);
    expect(result.message).toMatch(/did not complete|by hand/i);
  });
});

describe("idempotency", () => {
  it("reuses a folder that already exists rather than making a second one", async () => {
    const h = harness();
    await h.drive.createFolder(DEFAULT_CONFIG.driveParentFolderId, "AMRL-0006 Wilder & Co");

    const result = await run(VALID, h);
    expect(result.outcome).toBe("ok");

    const matching = h.drive.all().filter((folder) => folder.name === "AMRL-0006 Wilder & Co");
    expect(matching).toHaveLength(1);
    const step = result.steps.find((s) => s.stepId === "create-folder");
    expect(step?.attempts[0]?.detail).toMatch(/already existed/);
  });
});

describe("the data model", () => {
  it("round-trips a record through the sheet row shape", () => {
    const record = fromRowValues(SEED_ROWS[0]!);
    expect(toRowValues(record)).toEqual(SEED_ROWS[0]);
  });

  it("puts the Drive folder in column L", () => {
    // The Make blueprint writes index 11 and the docs say column L; all three must agree.
    expect(columnLetter("driveFolderUrl")).toBe("L");
    expect(columnLetter("clientId")).toBe("A");
    expect(columnLetter("notes")).toBe("U");
  });

  it("dates the deposit seven days out", () => {
    expect(depositDueDate("2026-09-19T10:00:00.000Z")).toBe("2026-09-26");
  });

  it("pads client ids so they sort", () => {
    expect(formatClientId(7)).toBe("AMRL-0007");
    expect(formatClientId(1234)).toBe("AMRL-1234");
  });

  it("strips characters Drive dislikes from folder names", () => {
    expect(folderName({ clientId: "AMRL-0009", company: "Smith/Jones: Ltd" })).toBe("AMRL-0009 Smith-Jones- Ltd");
  });

  it("trims and lowercases the email before it is stored", () => {
    const parsed = intakeSchema.parse({ ...VALID, email: "  SASHA@Wilderandco.Example  " });
    expect(parsed.email).toBe("sasha@wilderandco.example");
  });
});

describe("the executor itself", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("treats an unrecognised error as permanent", async () => {
    const h = harness();
    const exploding = [
      {
        id: "boom",
        moduleRef: "test",
        label: "Explodes",
        describes: "",
        fatal: true,
        maxAttempts: 3,
        run: async () => {
          throw new TypeError("undefined is not a function");
        },
      },
    ];

    const result = await runWorkflow({
      intake: VALID,
      sheets: h.sheets,
      drive: h.drive,
      mail: h.mail,
      now: () => NOW,
      backoffMs: 0,
      steps: exploding,
    });

    // Retrying an unknown failure three times usually produces the same failure three times.
    expect(result.steps[0]?.attempts).toHaveLength(1);
    expect(result.outcome).toBe("failed");
    warn.mockRestore();
  });

  it("surfaces the remedy from a StepError", async () => {
    const h = harness();
    const result = await runWorkflow({
      intake: VALID,
      sheets: h.sheets,
      drive: h.drive,
      mail: h.mail,
      now: () => NOW,
      backoffMs: 0,
      steps: [
        {
          id: "nope",
          moduleRef: "test",
          label: "Fails helpfully",
          describes: "",
          fatal: false,
          maxAttempts: 1,
          run: async () => {
            throw new StepError("the thing broke", {
              retryable: false,
              code: "test.broke",
              remedy: "Turn it off and on again.",
            });
          },
        },
      ],
    });

    expect(result.steps[0]?.remedy).toBe("Turn it off and on again.");
    expect(result.outcome).toBe("degraded");
    warn.mockRestore();
  });
});
