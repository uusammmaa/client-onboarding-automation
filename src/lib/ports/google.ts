import { google, type drive_v3, type gmail_v1, type sheets_v4 } from "googleapis";
import { StepError, isTransient, type DriveFolder, type DrivePort, type MailMessage, type MailPort, type SheetsPort } from "./index";

/**
 * Google adapters.
 *
 * One OAuth client, three APIs. Authentication is a service account with domain-wide
 * delegation impersonating a real mailbox, because Gmail will not send as a service
 * account — it has no mailbox of its own. That single fact is the reason the setup has an
 * impersonation step, and it is the thing most people get stuck on.
 */

export type EnvLike = Record<string, string | undefined>;

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.send",
];

export interface GoogleAuthConfig {
  clientEmail: string;
  privateKey: string;
  /** The mailbox to act as. Required for Gmail; harmless for Sheets and Drive. */
  impersonate: string;
}

export function googleAuthFromEnv(env: EnvLike = process.env): GoogleAuthConfig | null {
  const clientEmail = env.GOOGLE_CLIENT_EMAIL;
  const privateKey = env.GOOGLE_PRIVATE_KEY;
  const impersonate = env.GOOGLE_IMPERSONATE_SUBJECT;
  if (!clientEmail || !privateKey || !impersonate) return null;
  return { clientEmail, privateKey, impersonate };
}

function jwt(config: GoogleAuthConfig) {
  return new google.auth.JWT({
    email: config.clientEmail,
    // Hosting UIs flatten newlines out of multi-line secrets; put them back.
    key: config.privateKey.replace(/\\n/g, "\n"),
    scopes: SCOPES,
    subject: config.impersonate,
  });
}

/** Turn a googleapis error into something the executor can make a decision about. */
function toStepError(error: unknown, service: string, remedy: string): StepError {
  const err = error as { code?: number; status?: number; message?: string; errors?: Array<{ reason?: string }> };
  const status = err.code ?? err.status;
  const reason = err.errors?.[0]?.reason;
  return new StepError(`${service}: ${err.message ?? String(error)}`, {
    retryable: isTransient(status, reason),
    code: `${service.toLowerCase()}.${reason ?? status ?? "unknown"}`,
    remedy,
    underlying: error,
  });
}

/* ------------------------------------------------------------------ sheets ---- */

export class GoogleSheets implements SheetsPort {
  readonly name = "google";
  private readonly api: sheets_v4.Sheets;

  constructor(config: GoogleAuthConfig) {
    this.api = google.sheets({ version: "v4", auth: jwt(config) });
  }

  static fromEnv(env: EnvLike = process.env): GoogleSheets | null {
    const config = googleAuthFromEnv(env);
    return config ? new GoogleSheets(config) : null;
  }

  async ensureTab(spreadsheetId: string, tab: string, header: string[]): Promise<void> {
    try {
      const meta = await this.api.spreadsheets.get({ spreadsheetId });
      const exists = meta.data.sheets?.some((sheet) => sheet.properties?.title === tab);
      if (exists) return;

      await this.api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] },
      });
      await this.api.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [header] },
      });
    } catch (error) {
      throw toStepError(error, "Sheets", "Share the spreadsheet with the service account as an Editor.");
    }
  }

  async appendRow(spreadsheetId: string, tab: string, values: string[]): Promise<{ rowNumber: number }> {
    try {
      const response = await this.api.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A:A`,
        // RAW, not USER_ENTERED: a brief starting with "=" or "+" would otherwise be
        // interpreted as a formula, which is both wrong and a spreadsheet-injection risk.
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [values] },
      });

      const updatedRange = response.data.updates?.updatedRange ?? "";
      const rowNumber = Number(updatedRange.match(/!\w+?(\d+)/)?.[1] ?? 0);
      if (!rowNumber) {
        throw new StepError("Sheets did not say which row it wrote", {
          retryable: true,
          code: "sheets.noRowNumber",
          remedy: "Usually a transient API response. The retry normally resolves it.",
        });
      }
      return { rowNumber };
    } catch (error) {
      if (error instanceof StepError) throw error;
      throw toStepError(error, "Sheets", "Share the spreadsheet with the service account as an Editor.");
    }
  }

  async updateCell(spreadsheetId: string, tab: string, cell: string, value: string): Promise<void> {
    try {
      await this.api.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!${cell}`,
        valueInputOption: "RAW",
        requestBody: { values: [[value]] },
      });
    } catch (error) {
      throw toStepError(error, "Sheets", "Check the tab name and that the service account can edit it.");
    }
  }

  async readRows(spreadsheetId: string, tab: string): Promise<string[][]> {
    try {
      const response = await this.api.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A2:Z` });
      return (response.data.values ?? []).map((row) => row.map((cell) => String(cell ?? "")));
    } catch (error) {
      throw toStepError(error, "Sheets", "Check the spreadsheet ID and the tab name.");
    }
  }
}

/* ------------------------------------------------------------------- drive ---- */

export class GoogleDrive implements DrivePort {
  readonly name = "google";
  private readonly api: drive_v3.Drive;

  constructor(config: GoogleAuthConfig) {
    this.api = google.drive({ version: "v3", auth: jwt(config) });
  }

  static fromEnv(env: EnvLike = process.env): GoogleDrive | null {
    const config = googleAuthFromEnv(env);
    return config ? new GoogleDrive(config) : null;
  }

  async findFolder(parentId: string, name: string): Promise<DriveFolder | null> {
    try {
      const escaped = name.replace(/'/g, "\\'");
      const response = await this.api.files.list({
        q: `'${parentId}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id, name, webViewLink)",
        pageSize: 1,
        // Required for folders that live in a shared drive rather than My Drive.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const file = response.data.files?.[0];
      return file?.id ? { id: file.id, name: file.name ?? name, webViewLink: file.webViewLink ?? link(file.id) } : null;
    } catch (error) {
      throw toStepError(error, "Drive", "Check DRIVE_CLIENTS_FOLDER_ID and that the folder is shared with the service account.");
    }
  }

  async createFolder(parentId: string, name: string): Promise<DriveFolder> {
    try {
      const response = await this.api.files.create({
        requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
        fields: "id, name, webViewLink",
        supportsAllDrives: true,
      });
      const id = response.data.id;
      if (!id) throw new StepError("Drive created a folder with no id", { retryable: true, code: "drive.noId" });
      return { id, name: response.data.name ?? name, webViewLink: response.data.webViewLink ?? link(id) };
    } catch (error) {
      if (error instanceof StepError) throw error;
      throw toStepError(error, "Drive", "Check DRIVE_CLIENTS_FOLDER_ID and that the service account can write to it.");
    }
  }
}

function link(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

/* -------------------------------------------------------------------- mail ---- */

export class GoogleMail implements MailPort {
  readonly name = "gmail";
  private readonly api: gmail_v1.Gmail;

  constructor(
    config: GoogleAuthConfig,
    private readonly from: string,
  ) {
    this.api = google.gmail({ version: "v1", auth: jwt(config) });
  }

  static fromEnv(env: EnvLike = process.env): GoogleMail | null {
    const config = googleAuthFromEnv(env);
    return config ? new GoogleMail(config, env.GMAIL_SEND_AS ?? config.impersonate) : null;
  }

  async send(message: MailMessage): Promise<{ messageId: string }> {
    try {
      const response = await this.api.users.messages.send({
        userId: "me",
        requestBody: { raw: encodeMessage(message, this.from) },
      });
      return { messageId: response.data.id ?? "" };
    } catch (error) {
      throw toStepError(error, "Gmail", "Reconnect the Gmail account, or check the alert address for a typo.");
    }
  }
}

/**
 * RFC 2822 message, base64url encoded, which is what Gmail's `raw` field wants.
 *
 * The subject is RFC 2047 encoded because a company name with an accent in it would
 * otherwise arrive as mojibake, and a media company's client list is full of those.
 */
function encodeMessage(message: MailMessage, from: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${message.to.join(", ")}`,
    message.cc?.length ? `Cc: ${message.cc.join(", ")}` : "",
    message.replyTo ? `Reply-To: ${message.replyTo}` : "",
    `Subject: =?UTF-8?B?${Buffer.from(message.subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);

  const raw = `${headers.join("\r\n")}\r\n\r\n${message.body}`;
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
