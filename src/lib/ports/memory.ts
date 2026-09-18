import type { DriveFolder, DrivePort, MailMessage, MailPort, SheetsPort } from "./index";
import { StepError } from "./index";

/**
 * In-memory implementations of the three ports, plus failure injection.
 *
 * Failure injection is not a testing afterthought here — it is the feature that makes the
 * error handling demonstrable. A client reading "simple error handling" in a proposal
 * cannot tell whether it works. Being able to tick "Drive quota exceeded" and watch the
 * run retry twice, give up, alert the team and still keep the row in the Sheet is the
 * difference between a claim and a demonstration.
 */

export type FailureMode =
  | "none"
  | "sheets_rate_limit"
  | "sheets_permission"
  | "drive_quota"
  | "drive_permission"
  | "gmail_auth"
  | "gmail_bounce";

export const FAILURE_MODES: Array<{ id: FailureMode; label: string; describes: string }> = [
  { id: "none", label: "Everything working", describes: "The happy path." },
  {
    id: "sheets_rate_limit",
    label: "Sheets rate limit (429)",
    describes: "Transient. Retries with backoff and almost always succeeds on the second attempt.",
  },
  {
    id: "sheets_permission",
    label: "Sheet not shared (403)",
    describes: "Not transient. Fails immediately, alerts the team, and tells them exactly what to fix.",
  },
  {
    id: "drive_quota",
    label: "Drive quota exceeded",
    describes: "Retries, then gives up. The row is already in the Sheet, so nothing is lost.",
  },
  {
    id: "drive_permission",
    label: "Drive parent folder missing",
    describes: "Configuration error. No amount of retrying fixes it, so it does not try.",
  },
  {
    id: "gmail_auth",
    label: "Gmail token expired",
    describes: "The last step fails. The client is still onboarded; only the internal alert is lost.",
  },
  {
    id: "gmail_bounce",
    label: "Alert address rejected",
    describes: "Permanent. Alerts nobody, which is why the run result records it.",
  },
];

export interface InjectionState {
  mode: FailureMode;
  /** Transient failures stop after this many attempts, the way a real rate limit does. */
  failFirstNAttempts: number;
}

export class FailureInjector {
  private attempts = new Map<string, number>();

  constructor(public state: InjectionState = { mode: "none", failFirstNAttempts: 1 }) {}

  /** Call at the top of every port method that the injector can affect. */
  check(service: "sheets" | "drive" | "gmail"): void {
    const mode = this.state.mode;
    if (mode === "none" || !mode.startsWith(service)) return;

    const attempt = (this.attempts.get(mode) ?? 0) + 1;
    this.attempts.set(mode, attempt);

    const spec = INJECTED[mode];
    if (!spec) return;
    if (spec.retryable && attempt > this.state.failFirstNAttempts) return;

    throw new StepError(spec.message, { retryable: spec.retryable, code: spec.code, remedy: spec.remedy });
  }

  reset(): void {
    this.attempts.clear();
  }
}

const INJECTED: Partial<Record<FailureMode, { message: string; code: string; retryable: boolean; remedy: string }>> = {
  sheets_rate_limit: {
    message: "Google Sheets returned 429: quota exceeded for quota metric 'Write requests'",
    code: "sheets.rateLimit",
    retryable: true,
    remedy: "No action needed unless it keeps happening. If it does, raise the quota in the Google Cloud console.",
  },
  sheets_permission: {
    message: "Google Sheets returned 403: the caller does not have permission",
    code: "sheets.forbidden",
    retryable: false,
    remedy: "Share the tracker spreadsheet with the automation's service account as an Editor.",
  },
  drive_quota: {
    message: "Google Drive returned 403: user rate limit exceeded",
    code: "drive.rateLimit",
    retryable: true,
    remedy: "Usually clears itself. If it does not, check whether another automation is hammering the same Drive.",
  },
  drive_permission: {
    message: "Google Drive returned 404: parent folder not found",
    code: "drive.parentMissing",
    retryable: false,
    remedy: "Check DRIVE_CLIENTS_FOLDER_ID. The folder may have been moved to the bin or renamed.",
  },
  gmail_auth: {
    message: "Gmail returned 401: invalid credentials",
    code: "gmail.unauthorised",
    retryable: false,
    remedy: "Reconnect the Gmail account. OAuth tokens expire when the password changes.",
  },
  gmail_bounce: {
    message: "Gmail returned 400: recipient address rejected",
    code: "gmail.badRecipient",
    retryable: false,
    remedy: "Check the alert address in the scenario settings for a typo.",
  },
};

/* ------------------------------------------------------------------ sheets ---- */

export class MemorySheets implements SheetsPort {
  readonly name = "in-memory";
  private readonly tabs = new Map<string, string[][]>();

  constructor(private readonly injector = new FailureInjector()) {}

  private key(spreadsheetId: string, tab: string): string {
    return `${spreadsheetId}::${tab}`;
  }

  async ensureTab(spreadsheetId: string, tab: string, header: string[]): Promise<void> {
    const key = this.key(spreadsheetId, tab);
    if (!this.tabs.has(key)) this.tabs.set(key, [header]);
  }

  async appendRow(spreadsheetId: string, tab: string, values: string[]): Promise<{ rowNumber: number }> {
    this.injector.check("sheets");
    const key = this.key(spreadsheetId, tab);
    const rows = this.tabs.get(key) ?? [[]];
    rows.push(values);
    this.tabs.set(key, rows);
    return { rowNumber: rows.length };
  }

  async updateCell(spreadsheetId: string, tab: string, cell: string, value: string): Promise<void> {
    this.injector.check("sheets");
    const match = cell.match(/^([A-Z]+)(\d+)$/);
    if (!match) throw new StepError(`Not a cell reference: ${cell}`, { retryable: false, code: "sheets.badRange" });

    const columnIndex = columnToIndex(match[1] as string);
    const rowIndex = Number(match[2]) - 1;
    const rows = this.tabs.get(this.key(spreadsheetId, tab));
    const row = rows?.[rowIndex];
    if (!row) throw new StepError(`Row ${match[2]} does not exist`, { retryable: false, code: "sheets.noSuchRow" });

    while (row.length <= columnIndex) row.push("");
    row[columnIndex] = value;
  }

  async readRows(spreadsheetId: string, tab: string): Promise<string[][]> {
    const rows = this.tabs.get(this.key(spreadsheetId, tab)) ?? [];
    return rows.slice(1).map((row) => [...row]);
  }

  /** Test and demo helper - seed the tracker with existing clients. */
  seed(spreadsheetId: string, tab: string, header: string[], rows: string[][]): void {
    this.tabs.set(this.key(spreadsheetId, tab), [header, ...rows.map((r) => [...r])]);
  }
}

function columnToIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/* ------------------------------------------------------------------- drive ---- */

export class MemoryDrive implements DrivePort {
  readonly name = "in-memory";
  private readonly folders = new Map<string, DriveFolder & { parentId: string }>();
  private seq = 0;

  constructor(private readonly injector = new FailureInjector()) {}

  async findFolder(parentId: string, name: string): Promise<DriveFolder | null> {
    this.injector.check("drive");
    for (const folder of this.folders.values()) {
      if (folder.parentId === parentId && folder.name === name) return { ...folder };
    }
    return null;
  }

  async createFolder(parentId: string, name: string): Promise<DriveFolder> {
    this.injector.check("drive");
    // Drive genuinely allows duplicate names, so the workflow must check first rather
    // than relying on a uniqueness constraint that does not exist.
    const existing = await this.findFolder(parentId, name);
    if (existing) return existing;

    const id = `fldr_${String(++this.seq).padStart(4, "0")}`;
    const folder = { id, name, webViewLink: `https://drive.google.com/drive/folders/${id}`, parentId };
    this.folders.set(id, folder);
    return { id: folder.id, name: folder.name, webViewLink: folder.webViewLink };
  }

  all(): DriveFolder[] {
    return [...this.folders.values()].map((f) => ({ id: f.id, name: f.name, webViewLink: f.webViewLink }));
  }
}

/* -------------------------------------------------------------------- mail ---- */

export class MemoryMail implements MailPort {
  readonly name = "in-memory";
  readonly sent: Array<MailMessage & { messageId: string; sentAt: string }> = [];
  private seq = 0;

  constructor(private readonly injector = new FailureInjector()) {}

  async send(message: MailMessage): Promise<{ messageId: string }> {
    this.injector.check("gmail");
    const messageId = `msg_${String(++this.seq).padStart(4, "0")}`;
    this.sent.push({ ...message, messageId, sentAt: new Date().toISOString() });
    return { messageId };
  }
}
