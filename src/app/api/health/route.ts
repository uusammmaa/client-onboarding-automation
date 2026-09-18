import { buildRuntime } from "@/lib/runtime";
import { STEPS } from "@/lib/pipeline/steps";
import { SHEET_COLUMNS } from "@/lib/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — which adapters resolved, and the shape of the workflow. */
export async function GET(): Promise<Response> {
  const rt = buildRuntime();
  return Response.json({
    status: "ok",
    mode: rt.mode,
    workflow: {
      steps: STEPS.map((step) => ({
        id: step.id,
        label: step.label,
        moduleRef: step.moduleRef,
        fatal: step.fatal,
        maxAttempts: step.maxAttempts,
      })),
      sheetColumns: SHEET_COLUMNS.length,
    },
  });
}
