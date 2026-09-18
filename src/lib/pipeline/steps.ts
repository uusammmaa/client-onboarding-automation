import {
  FOLDER_TEMPLATE,
  buildRecord,
  columnLetter,
  depositAmountGbp,
  folderName,
  formatClientId,
  fromRowValues,
  intakeSchema,
  SHEET_COLUMNS,
  toRowValues,
  type ClientRecord,
  type Intake,
} from "../model";
import { StepError, type DrivePort, type MailPort, type SheetsPort } from "../ports";

/**
 * The workflow, one step per Make module.
 *
 * The mapping is deliberate and one-to-one: `step.moduleRef` names the module in
 * `make/blueprint.json` and the node in `n8n/workflow.json`. When the client asks "what
 * does module 5 do", the answer is a function with a name and a test, not a screenshot.
 *
 * Every step declares whether a failure is fatal to the run. That single flag is the
 * whole of the error policy: the Sheet row is worth more than the Drive folder, and the
 * Drive folder is worth more than the internal alert email, so a Gmail outage must not
 * roll back a client onboarding.
 */

export interface StepContext {
  intake: Intake;
  record: ClientRecord;
  /** 1-based row number in the Clients tab, once the row exists. */
  rowNumber?: number;
  config: WorkflowConfig;
  sheets: SheetsPort;
  drive: DrivePort;
  mail: MailPort;
  now: () => Date;
}

export interface WorkflowConfig {
  spreadsheetId: string;
  clientsTab: string;
  errorsTab: string;
  driveParentFolderId: string;
  alertTo: string[];
  alertCc?: string[];
  replyTo?: string;
  /** Names briefs are assigned round-robin by project type. */
  roster: string[];
  clientIdPrefix: string;
  companyName: string;
}

export const DEFAULT_CONFIG: WorkflowConfig = {
  spreadsheetId: "demo-tracker",
  clientsTab: "Clients",
  errorsTab: "Errors",
  driveParentFolderId: "demo-clients-root",
  alertTo: ["studio@amrl.example"],
  alertCc: ["accounts@amrl.example"],
  replyTo: "studio@amrl.example",
  roster: ["Nadia", "Joel", "Priya"],
  clientIdPrefix: "AMRL",
  companyName: "AMRL Media",
};

export interface Step {
  /** Stable id, used in the execution log and in the docs. */
  id: string;
  /** How this appears in the Make scenario and the n8n workflow. */
  moduleRef: string;
  label: string;
  /** One line explaining what it does, shown in the UI. */
  describes: string;
  /** False when the run should carry on after this step fails. */
  fatal: boolean;
  /** Transient failures get this many extra attempts. */
  maxAttempts: number;
  run(context: StepContext): Promise<string>;
}

/* ------------------------------------------------------------------- steps ---- */

const validate: Step = {
  id: "validate",
  moduleRef: "Module 2 · Router → validation filter",
  label: "Validate the submission",
  describes: "Rejects an incomplete or malformed brief before anything is written anywhere.",
  fatal: true,
  maxAttempts: 1,
  async run(context) {
    const parsed = intakeSchema.safeParse(context.intake);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new StepError(`The submission is not valid: ${detail}`, {
        retryable: false,
        code: "validation.failed",
        remedy: "The form should have caught this. If it did not, check the field is on the form and required.",
      });
    }
    return `${parsed.data.company} · ${parsed.data.projectType} · £${parsed.data.budgetGbp.toLocaleString("en-GB")}`;
  },
};

const assignId: Step = {
  id: "assign-id",
  moduleRef: "Module 3 · Tools → Set variables",
  label: "Assign a client ID",
  describes: "Reads the last row of the tracker and takes the next number in sequence.",
  fatal: true,
  maxAttempts: 3,
  async run(context) {
    await context.sheets.ensureTab(
      context.config.spreadsheetId,
      context.config.clientsTab,
      SHEET_COLUMNS.map((column) => column.header),
    );

    const rows = await context.sheets.readRows(context.config.spreadsheetId, context.config.clientsTab);
    // Deriving the sequence from the highest id present, rather than the row count, means
    // a manually deleted row does not cause the next client to reuse an id that is
    // already on an invoice.
    const highest = rows.reduce((max, row) => {
      const id = row[0] ?? "";
      const match = id.match(/(\d+)$/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);

    const clientId = formatClientId(highest + 1, context.config.clientIdPrefix);
    context.record = buildRecord(context.intake, {
      clientId,
      now: context.now(),
      roster: context.config.roster,
    });
    return `${clientId}, assigned to ${context.record.owner}`;
  },
};

const appendRow: Step = {
  id: "append-row",
  moduleRef: "Module 4 · Google Sheets → Add a row",
  label: "Add a row to the tracker",
  describes: "Writes the brief into the Clients tab. This is the step that must not be lost.",
  fatal: true,
  maxAttempts: 3,
  async run(context) {
    const { rowNumber } = await context.sheets.appendRow(
      context.config.spreadsheetId,
      context.config.clientsTab,
      toRowValues(context.record),
    );
    context.rowNumber = rowNumber;
    return `Row ${rowNumber} in ${context.config.clientsTab}`;
  },
};

const createFolder: Step = {
  id: "create-folder",
  moduleRef: "Module 5 · Google Drive → Create a folder",
  label: "Create the client folder",
  describes: "Makes one folder per client under the shared Clients folder, named by ID and company.",
  // Not fatal: a client with a row and no folder is a five-second fix. A client with a
  // folder and no row is invisible.
  fatal: false,
  maxAttempts: 3,
  async run(context) {
    const name = folderName(context.record);
    const existing = await context.drive.findFolder(context.config.driveParentFolderId, name);
    const folder = existing ?? (await context.drive.createFolder(context.config.driveParentFolderId, name));
    context.record.driveFolderUrl = folder.webViewLink;
    return existing ? `${name} already existed, reused it` : name;
  },
};

const createSubfolders: Step = {
  id: "create-subfolders",
  moduleRef: "Modules 6–9 · Google Drive → Create a folder ×4",
  label: "Create the working subfolders",
  describes: "Four subfolders so everyone puts things in the same place from day one.",
  fatal: false,
  maxAttempts: 3,
  async run(context) {
    if (!context.record.driveFolderUrl) {
      throw new StepError("No client folder to put subfolders in", {
        retryable: false,
        code: "drive.noParent",
        remedy: "The folder step failed. Fix that first; this one will follow.",
      });
    }
    const parentId = folderIdFromUrl(context.record.driveFolderUrl);
    for (const name of FOLDER_TEMPLATE) {
      await context.drive.createFolder(parentId, name);
    }
    return FOLDER_TEMPLATE.join(", ");
  },
};

const linkFolder: Step = {
  id: "link-folder",
  moduleRef: "Module 10 · Google Sheets → Update a row",
  label: "Put the folder link on the row",
  describes: "Writes the Drive link back into the tracker so the Sheet is the only place anyone needs to look.",
  fatal: false,
  maxAttempts: 3,
  async run(context) {
    if (!context.rowNumber) {
      throw new StepError("No row to update", { retryable: false, code: "sheets.noRow" });
    }
    if (!context.record.driveFolderUrl) {
      return "Skipped - there is no folder link to write yet";
    }
    const cell = `${columnLetter("driveFolderUrl")}${context.rowNumber}`;
    await context.sheets.updateCell(
      context.config.spreadsheetId,
      context.config.clientsTab,
      cell,
      context.record.driveFolderUrl,
    );
    return `Cell ${cell}`;
  },
};

const notify: Step = {
  id: "notify",
  moduleRef: "Module 11 · Gmail → Send an email",
  label: "Email the studio",
  describes: "One alert with everything needed to pick the brief up, including both links.",
  fatal: false,
  maxAttempts: 2,
  async run(context) {
    const { messageId } = await context.mail.send({
      to: context.config.alertTo,
      cc: context.config.alertCc,
      replyTo: context.record.email,
      subject: `New brief · ${context.record.company} · ${context.record.projectType} · £${context.record.budgetGbp.toLocaleString("en-GB")}`,
      body: alertBody(context),
    });
    return `Sent to ${context.config.alertTo.join(", ")} (${messageId})`;
  },
};

export const STEPS: Step[] = [validate, assignId, appendRow, createFolder, createSubfolders, linkFolder, notify];

/* ----------------------------------------------------------------- helpers ---- */

function folderIdFromUrl(url: string): string {
  return url.split("/").pop() ?? url;
}

function alertBody(context: StepContext): string {
  const r = context.record;
  const deposit = depositAmountGbp(r.budgetGbp);
  return [
    `${r.contactName} at ${r.company} has sent a brief.`,
    "",
    `Client ID     ${r.clientId}`,
    `Project       ${r.projectType}`,
    `Budget        £${r.budgetGbp.toLocaleString("en-GB")}`,
    `Deposit       £${deposit.toLocaleString("en-GB")} due ${r.depositDue}`,
    `Deadline      ${r.deadline}`,
    `Owner         ${r.owner}`,
    `Contact       ${r.email}${r.phone ? ` · ${r.phone}` : ""}`,
    r.heardAbout ? `Found us via  ${r.heardAbout}` : "",
    "",
    "Brief",
    r.brief,
    "",
    r.driveFolderUrl ? `Folder        ${r.driveFolderUrl}` : "Folder        not created - see the error alert",
    `Tracker row   ${context.rowNumber ?? "unknown"}`,
    "",
    `Reply to this email to answer ${r.contactName} directly.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Read the tracker back as records, for the dashboard. */
export async function readTracker(sheets: SheetsPort, config: WorkflowConfig): Promise<ClientRecord[]> {
  const rows = await sheets.readRows(config.spreadsheetId, config.clientsTab);
  return rows.filter((row) => row[0]).map(fromRowValues);
}
