import { z } from "zod";
import { intakeSchema, toRowValues } from "@/lib/model";
import { runWorkflow } from "@/lib/pipeline/run";
import { buildRuntime } from "@/lib/runtime";
import { readTracker } from "@/lib/pipeline/steps";
import type { FailureMode } from "@/lib/ports/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/intake — the webhook the form posts to.
 *
 * This is the reference implementation of the Make scenario. In a real deployment Make's
 * webhook module sits here instead and the browser posts to that URL; the steps, the
 * order and the error policy are identical, which is the point of the repo.
 *
 * In demo mode the browser sends the tracker rows it already has and gets the updated set
 * back. That keeps the server stateless on serverless hosting, where an in-process store
 * is not reliably the same process twice. With Google credentials configured, the rows
 * come from the real spreadsheet and the browser's copy is ignored.
 */

const bodySchema = z.object({
  intake: intakeSchema,
  /** Demo mode only. Ignored when Google credentials are configured. */
  rows: z.array(z.array(z.string())).max(500).optional(),
  failureMode: z
    .enum([
      "none",
      "sheets_rate_limit",
      "sheets_permission",
      "drive_quota",
      "drive_permission",
      "gmail_auth",
      "gmail_bounce",
    ])
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    // The form validates with the same schema, so reaching here means either a direct
    // API call or a form that has drifted. Either way, say which field.
    return Response.json(
      {
        error: "That submission is not valid",
        fields: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const rt = buildRuntime({
    existingRows: parsed.data.rows,
    failureMode: parsed.data.failureMode as FailureMode | undefined,
  });

  const result = await runWorkflow({
    intake: parsed.data.intake,
    sheets: rt.sheets,
    drive: rt.drive,
    mail: rt.mail,
    config: rt.config,
    // Short enough that the demo does not feel broken, long enough to be visible.
    backoffMs: rt.mode.live ? 800 : 150,
  });

  const tracker = await readTracker(rt.sheets, rt.config).catch(() => []);

  return Response.json({
    result,
    mode: rt.mode,
    rows: tracker.map(toRowValues),
    clients: tracker,
  });
}
