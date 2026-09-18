import { CLIENTS_HEADER } from "./pipeline/run";
import { DEFAULT_CONFIG, type WorkflowConfig } from "./pipeline/steps";
import { GoogleDrive, GoogleMail, GoogleSheets, googleAuthFromEnv } from "./ports/google";
import { FailureInjector, MemoryDrive, MemoryMail, MemorySheets, type FailureMode } from "./ports/memory";
import { SEED_ROWS } from "./demo-data";
import type { DrivePort, MailPort, SheetsPort } from "./ports";

/**
 * Wiring for one request.
 *
 * Google where credentials exist, in-memory otherwise, and the mode is reported rather
 * than hidden. On the hosted demo the tracker is seeded fresh per request and the
 * browser keeps whatever it has added — see the note in the API route about why the
 * server holds no state.
 */

export interface Runtime {
  sheets: SheetsPort;
  drive: DrivePort;
  mail: MailPort;
  config: WorkflowConfig;
  mode: { sheets: string; drive: string; mail: string; live: boolean };
}

export interface RuntimeOptions {
  /** Rows already in the tracker, sent by the browser in demo mode. */
  existingRows?: string[][];
  failureMode?: FailureMode;
  env?: Record<string, string | undefined>;
}

export function buildRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const config: WorkflowConfig = {
    ...DEFAULT_CONFIG,
    spreadsheetId: env.SHEETS_SPREADSHEET_ID ?? DEFAULT_CONFIG.spreadsheetId,
    clientsTab: env.SHEETS_CLIENTS_TAB ?? DEFAULT_CONFIG.clientsTab,
    errorsTab: env.SHEETS_ERRORS_TAB ?? DEFAULT_CONFIG.errorsTab,
    driveParentFolderId: env.DRIVE_CLIENTS_FOLDER_ID ?? DEFAULT_CONFIG.driveParentFolderId,
    alertTo: splitList(env.ALERT_TO) ?? DEFAULT_CONFIG.alertTo,
    alertCc: splitList(env.ALERT_CC) ?? DEFAULT_CONFIG.alertCc,
    roster: splitList(env.TEAM_ROSTER) ?? DEFAULT_CONFIG.roster,
    clientIdPrefix: env.CLIENT_ID_PREFIX ?? DEFAULT_CONFIG.clientIdPrefix,
    companyName: env.COMPANY_NAME ?? DEFAULT_CONFIG.companyName,
  };

  const live = googleAuthFromEnv(env) !== null;

  if (live) {
    const sheets = GoogleSheets.fromEnv(env);
    const drive = GoogleDrive.fromEnv(env);
    const mail = GoogleMail.fromEnv(env);
    if (sheets && drive && mail) {
      return {
        sheets,
        drive,
        mail,
        config,
        mode: { sheets: sheets.name, drive: drive.name, mail: mail.name, live: true },
      };
    }
  }

  // Failure injection is shared across the three ports so "Drive quota exceeded" affects
  // Drive and nothing else, and the attempt counter is common to the whole run.
  const injector = new FailureInjector({ mode: options.failureMode ?? "none", failFirstNAttempts: 1 });
  const sheets = new MemorySheets(injector);
  sheets.seed(config.spreadsheetId, config.clientsTab, CLIENTS_HEADER, options.existingRows ?? SEED_ROWS);

  return {
    sheets,
    drive: new MemoryDrive(injector),
    mail: new MemoryMail(injector),
    config,
    mode: { sheets: "in-memory", drive: "in-memory", mail: "in-memory", live: false },
  };
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
