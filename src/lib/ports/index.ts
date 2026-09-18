/**
 * The three services this workflow touches, as ports.
 *
 * Each has a real Google implementation and an in-memory one. The in-memory ones are
 * what the hosted demo runs on, and they are also where failure injection lives — being
 * able to make Drive return a quota error on demand is how the error handling gets
 * tested, and how a reviewer can see it work.
 */

export interface SheetsPort {
  readonly name: string;
  /** Append a row and return its 1-based row number, the way Sheets does. */
  appendRow(spreadsheetId: string, tab: string, values: string[]): Promise<{ rowNumber: number }>;
  /** Write a single cell, addressed the way a person would: `M14`. */
  updateCell(spreadsheetId: string, tab: string, cell: string, value: string): Promise<void>;
  /** Every data row, header excluded. */
  readRows(spreadsheetId: string, tab: string): Promise<string[][]>;
  /** Create the tab with its header row if it is not there yet. */
  ensureTab(spreadsheetId: string, tab: string, header: string[]): Promise<void>;
}

export interface DriveFolder {
  id: string;
  name: string;
  webViewLink: string;
}

export interface DrivePort {
  readonly name: string;
  createFolder(parentId: string, name: string): Promise<DriveFolder>;
  /** Returns an existing folder of this name under the parent, if there is one. */
  findFolder(parentId: string, name: string): Promise<DriveFolder | null>;
}

export interface MailMessage {
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain text. Gmail gets an HTML part too, built from this. */
  body: string;
  replyTo?: string;
}

export interface MailPort {
  readonly name: string;
  send(message: MailMessage): Promise<{ messageId: string }>;
}

/**
 * A failure that the workflow understands.
 *
 * `retryable` is the field that matters: it decides whether the step backs off and tries
 * again or goes straight to the error route. Getting it wrong in either direction is
 * expensive — retrying a validation error wastes fifteen seconds and still fails, while
 * not retrying a rate limit loses the submission.
 */
export class StepError extends Error {
  constructor(
    message: string,
    readonly options: {
      retryable: boolean;
      /** Short machine-readable code, surfaced in the execution log and the alert. */
      code: string;
      /** What a human should do about it. Goes into the alert email verbatim. */
      remedy?: string;
      underlying?: unknown;
    },
  ) {
    super(message);
    this.name = "StepError";
  }

  get retryable(): boolean {
    return this.options.retryable;
  }
  get code(): string {
    return this.options.code;
  }
  get remedy(): string | undefined {
    return this.options.remedy;
  }
}

/**
 * Google's transient failures, in one place.
 *
 * 429 and 5xx are always worth retrying. 403 is ambiguous: it is both "rate limit
 * exceeded" and "you do not have permission", and only the reason string tells them
 * apart. Retrying a genuine permission error for forty seconds before failing is a bad
 * trade, so the reason is checked.
 */
export function isTransient(status: number | undefined, reason?: string): boolean {
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  if (status === 403 && reason) {
    return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|backendError/i.test(reason);
  }
  return false;
}
