import { z } from "zod";

/**
 * The data model, in one file.
 *
 * This is the contract the intake form, the Google Sheet, the Make scenario, the n8n
 * workflow and this reference implementation all agree on. When the Sheet needs a new
 * column, it is added here first and `SHEET_COLUMNS` is the thing that tells you which
 * letter it lands in — see docs/DATA-MODEL.md.
 */

/* ------------------------------------------------------------------ intake ---- */

export const PROJECT_TYPES = [
  "Brand film",
  "Social campaign",
  "Photography",
  "Website",
  "Event coverage",
  "Retainer",
] as const;

export const HEARD_ABOUT = ["Referral", "Instagram", "LinkedIn", "Google", "Existing client", "Other"] as const;

/** UK phone numbers, loosely: +44 or 0, then 9–10 digits, spaces and dashes allowed. */
const UK_PHONE = /^(?:\+44\s?|0)(?:\d\s?-?){9,10}$/;

export const intakeSchema = z.object({
  contactName: z.string().trim().min(2, "Give us a name we can use").max(80),
  company: z.string().trim().min(2, "Which company is this for?").max(120),
  email: z.string().trim().toLowerCase().email("That email address does not look right"),
  phone: z
    .string()
    .trim()
    .regex(UK_PHONE, "Use a UK number, like 07700 900123 or +44 7700 900123")
    .optional()
    .or(z.literal("")),
  projectType: z.enum(PROJECT_TYPES),
  budgetGbp: z
    .number({ invalid_type_error: "Budget must be a number" })
    .int("Round to the nearest pound")
    .min(500, "Our smallest project is £500")
    .max(500_000),
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date")
    .refine((value) => !Number.isNaN(Date.parse(value)), "That date is not real"),
  brief: z.string().trim().min(20, "Tell us a little more - at least a sentence or two").max(4000),
  heardAbout: z.enum(HEARD_ABOUT).optional(),
  marketingConsent: z.boolean().default(false),
});

export type Intake = z.infer<typeof intakeSchema>;

/* ------------------------------------------------------------------ record ---- */

export const CLIENT_STATUSES = ["New enquiry", "Onboarding", "In production", "Delivered", "Closed", "Lost"] as const;
export const PAYMENT_STATUSES = ["Awaiting deposit", "Deposit paid", "Invoiced", "Paid in full", "Overdue"] as const;
export const DELIVERY_STATUSES = ["Not started", "In progress", "With client for review", "Delivered"] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface ClientRecord {
  clientId: string;
  submittedAt: string;
  contactName: string;
  company: string;
  email: string;
  phone: string;
  projectType: string;
  budgetGbp: number;
  deadline: string;
  brief: string;
  heardAbout: string;
  driveFolderUrl: string;
  status: ClientStatus;
  paymentStatus: PaymentStatus;
  depositDue: string;
  amountPaidGbp: number;
  deliveryStatus: DeliveryStatus;
  deliveredAt: string;
  owner: string;
  lastUpdated: string;
  notes: string;
}

/**
 * Column order in the `Clients` sheet tab.
 *
 * Order matters and is load-bearing: `addRow` writes an array positionally and
 * `updateRow` addresses a cell by letter. Appending a field here is safe; reordering or
 * removing one silently corrupts every row written afterwards, which is why the setup
 * doc says to add columns at the end and never in the middle.
 */
export const SHEET_COLUMNS: Array<{ key: keyof ClientRecord; header: string; width?: number }> = [
  { key: "clientId", header: "Client ID", width: 110 },
  { key: "submittedAt", header: "Submitted", width: 140 },
  { key: "contactName", header: "Contact", width: 150 },
  { key: "company", header: "Company", width: 180 },
  { key: "email", header: "Email", width: 200 },
  { key: "phone", header: "Phone", width: 130 },
  { key: "projectType", header: "Project type", width: 140 },
  { key: "budgetGbp", header: "Budget (GBP)", width: 110 },
  { key: "deadline", header: "Deadline", width: 110 },
  { key: "brief", header: "Brief", width: 320 },
  { key: "heardAbout", header: "Heard about us", width: 130 },
  { key: "driveFolderUrl", header: "Drive folder", width: 200 },
  { key: "status", header: "Status", width: 130 },
  { key: "paymentStatus", header: "Payment", width: 130 },
  { key: "depositDue", header: "Deposit due", width: 110 },
  { key: "amountPaidGbp", header: "Paid (GBP)", width: 110 },
  { key: "deliveryStatus", header: "Delivery", width: 150 },
  { key: "deliveredAt", header: "Delivered", width: 110 },
  { key: "owner", header: "Owner", width: 120 },
  { key: "lastUpdated", header: "Last updated", width: 140 },
  { key: "notes", header: "Notes", width: 280 },
];

/** Spreadsheet column letter for a field, e.g. `columnLetter("status") === "M"`. */
export function columnLetter(key: keyof ClientRecord): string {
  const index = SHEET_COLUMNS.findIndex((c) => c.key === key);
  if (index === -1) throw new Error(`${key} is not a sheet column`);
  return String.fromCharCode(65 + index);
}

export function toRowValues(record: ClientRecord): string[] {
  return SHEET_COLUMNS.map((column) => {
    const value = record[column.key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function fromRowValues(values: string[]): ClientRecord {
  const record = {} as Record<string, unknown>;
  SHEET_COLUMNS.forEach((column, index) => {
    const raw = values[index] ?? "";
    record[column.key] = column.key === "budgetGbp" || column.key === "amountPaidGbp" ? Number(raw || 0) : raw;
  });
  return record as unknown as ClientRecord;
}

/* -------------------------------------------------------------- derivation ---- */

/** Subfolders created inside every client folder. Edit this list to change the shape. */
export const FOLDER_TEMPLATE = [
  "01 Brief and contract",
  "02 Assets from client",
  "03 Work in progress",
  "04 Final delivery",
] as const;

/**
 * Deposit terms: 50% up front, due 7 days after the enquiry. Kept here rather than in the
 * pipeline so the same rule is visible to whoever is editing the Make scenario.
 */
export const DEPOSIT_TERMS = { fraction: 0.5, dueInDays: 7 };

export function depositDueDate(submittedAt: string): string {
  const due = new Date(new Date(submittedAt).getTime() + DEPOSIT_TERMS.dueInDays * 86_400_000);
  return due.toISOString().slice(0, 10);
}

export function depositAmountGbp(budgetGbp: number): number {
  return Math.round(budgetGbp * DEPOSIT_TERMS.fraction);
}

/**
 * Client ids are sequential and human-readable, because they get read out on the phone
 * and typed into invoices. `AMRL-0042`, not a UUID.
 */
export function formatClientId(sequence: number, prefix = "AMRL"): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

/** Drive folder name. Kept free of characters that make Drive search unpleasant. */
export function folderName(record: Pick<ClientRecord, "clientId" | "company">): string {
  return `${record.clientId} ${record.company}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
}

/** A brief needs a person on it from the moment it arrives, or it sits unanswered. */
export function assignOwner(projectType: string, roster: string[]): string {
  if (roster.length === 0) return "Unassigned";
  const index = Math.abs(hash(projectType)) % roster.length;
  return roster[index] ?? "Unassigned";
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
  return value;
}

export function buildRecord(intake: Intake, options: { clientId: string; now: Date; roster: string[] }): ClientRecord {
  const submittedAt = options.now.toISOString();
  return {
    clientId: options.clientId,
    submittedAt,
    contactName: intake.contactName,
    company: intake.company,
    email: intake.email,
    phone: intake.phone ?? "",
    projectType: intake.projectType,
    budgetGbp: intake.budgetGbp,
    deadline: intake.deadline,
    brief: intake.brief,
    heardAbout: intake.heardAbout ?? "",
    driveFolderUrl: "",
    status: "New enquiry",
    paymentStatus: "Awaiting deposit",
    depositDue: depositDueDate(submittedAt),
    amountPaidGbp: 0,
    deliveryStatus: "Not started",
    deliveredAt: "",
    owner: assignOwner(intake.projectType, options.roster),
    lastUpdated: submittedAt,
    notes: "",
  };
}
