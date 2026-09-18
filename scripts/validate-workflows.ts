/**
 * Structural checks on the two exported workflows.
 *
 * Neither file can be executed in CI — that would need a Make account and an n8n
 * instance — so this checks the things that actually rot: a node referenced in
 * `connections` that no longer exists, a placeholder that got replaced by a real
 * spreadsheet ID before someone committed, an error route that was deleted, a step added
 * to the reference implementation and forgotten in the exports.
 *
 * Runs as part of `npm run verify`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STEPS } from "../src/lib/pipeline/steps";

const root = join(import.meta.dirname ?? __dirname, "..");
const failures: string[] = [];
const notes: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch (error) {
    failures.push(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/* ------------------------------------------------------------------- shared ---- */

/**
 * Anything that looks like a real Google ID. A committed spreadsheet ID is a data leak
 * and, worse, a scenario that silently writes to somebody else's tracker.
 */
const LOOKS_LIKE_REAL_ID = /\b[A-Za-z0-9_-]{30,}\b/;
const PLACEHOLDERS = ["PUT_YOUR_SPREADSHEET_ID_HERE", "PUT_YOUR_CLIENTS_FOLDER_ID_HERE"];

function checkNoRealCredentials(label: string, raw: string): void {
  for (const placeholder of PLACEHOLDERS) {
    check(raw.includes(placeholder), `${label}: placeholder ${placeholder} is missing — was a real ID committed?`);
  }

  // Ignore the synthetic node ids, which are long by design.
  const scrubbed = raw.replace(/"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"/g, '""');
  const suspicious = scrubbed.match(LOOKS_LIKE_REAL_ID);
  if (suspicious && !PLACEHOLDERS.some((p) => suspicious[0].includes(p.slice(0, 12)))) {
    notes.push(`${label}: check "${suspicious[0].slice(0, 40)}…" is not a real Google ID`);
  }

  check(!/AIza[0-9A-Za-z_-]{20,}/.test(raw), `${label}: contains what looks like a Google API key`);
  check(!/"access_token"|"refresh_token"|BEGIN PRIVATE KEY/.test(raw), `${label}: contains credential material`);
}

/* ---------------------------------------------------------------------- n8n ---- */

interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  onError?: string;
  retryOnFail?: boolean;
  maxTries?: number;
}

interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
  settings: Record<string, unknown>;
}

function validateN8n(): void {
  const raw = readFileSync(join(root, "n8n/workflow.json"), "utf8");
  const workflow = readJson("n8n/workflow.json") as N8nWorkflow | null;
  if (!workflow) return;

  checkNoRealCredentials("n8n", raw);

  check(typeof workflow.name === "string" && workflow.name.length > 0, "n8n: workflow has no name");
  check(Array.isArray(workflow.nodes) && workflow.nodes.length > 0, "n8n: no nodes");
  check(workflow.settings?.executionOrder === "v1", "n8n: executionOrder should be v1");

  const names = new Set(workflow.nodes.map((node) => node.name));
  check(names.size === workflow.nodes.length, "n8n: two nodes share a name, which breaks $('Node') references");

  const ids = new Set(workflow.nodes.map((node) => node.id));
  check(ids.size === workflow.nodes.length, "n8n: duplicate node ids");

  for (const [from, outputs] of Object.entries(workflow.connections)) {
    check(names.has(from), `n8n: connections reference "${from}", which is not a node`);
    for (const branch of outputs.main ?? []) {
      for (const target of branch) {
        check(names.has(target.node), `n8n: "${from}" connects to "${target.node}", which is not a node`);
      }
    }
  }

  // Every node except the trigger and the sticky notes must be reachable.
  const reachable = new Set<string>(["Form submission"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [from, outputs] of Object.entries(workflow.connections)) {
      if (!reachable.has(from)) continue;
      for (const branch of outputs.main ?? []) {
        for (const target of branch) {
          if (!reachable.has(target.node)) {
            reachable.add(target.node);
            grew = true;
          }
        }
      }
    }
  }
  for (const node of workflow.nodes) {
    if (node.type === "n8n-nodes-base.stickyNote") continue;
    check(reachable.has(node.name), `n8n: "${node.name}" is not reachable from the trigger`);
  }

  // Anything that talks to Google is allowed to fail transiently, so it must retry.
  for (const node of workflow.nodes) {
    if (!/googleSheets|googleDrive|gmail/i.test(node.type)) continue;
    check(node.retryOnFail === true, `n8n: "${node.name}" talks to Google but has no retry`);
    check((node.maxTries ?? 0) >= 2, `n8n: "${node.name}" should allow at least two attempts`);
  }

  // The steps that are not fatal must be allowed to continue.
  for (const name of ["Create client folder", "Email the studio"]) {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    check(Boolean(node), `n8n: missing node "${name}"`);
    check(
      node?.onError === "continueErrorOutput",
      `n8n: "${name}" is not fatal, so it must route failures rather than stop the run`,
    );
  }

  // And the one that is fatal must not be.
  const appendNode = workflow.nodes.find((node) => node.name === "Add row to tracker");
  check(
    appendNode !== undefined && appendNode.onError === undefined,
    "n8n: 'Add row to tracker' must stop the run on failure, not continue",
  );

  const stickies = workflow.nodes.filter((node) => node.type === "n8n-nodes-base.stickyNote");
  check(stickies.length >= 2, "n8n: the workflow should carry its own documentation as sticky notes");
}

/* --------------------------------------------------------------------- make ---- */

interface MakeModule {
  id: number;
  module?: string;
  routes?: Array<{ flow: MakeModule[] }>;
  onerror?: MakeModule[];
  metadata?: { designer?: { name?: string } };
  mapper?: unknown;
  filter?: unknown;
}

interface MakeBlueprint {
  name: string;
  flow: MakeModule[];
  metadata: { instant?: boolean; scenario?: Record<string, unknown>; notes?: unknown[] };
}

function walk(
  modules: MakeModule[],
  visit: (module: MakeModule, inErrorHandler: boolean) => void,
  inErrorHandler = false,
): void {
  for (const mod of modules) {
    visit(mod, inErrorHandler);
    for (const route of mod.routes ?? []) walk(route.flow, visit, inErrorHandler);
    // Modules inside an error handler are the recovery path. Requiring them to have
    // their own handler is turtles all the way down; if the recovery fails, Make parks
    // the run in the dead-letter queue, which is the correct end of the line.
    if (mod.onerror) walk(mod.onerror, visit, true);
  }
}

function validateMake(): void {
  const raw = readFileSync(join(root, "make/blueprint.json"), "utf8");
  const blueprint = readJson("make/blueprint.json") as MakeBlueprint | null;
  if (!blueprint) return;

  checkNoRealCredentials("make", raw);

  check(typeof blueprint.name === "string" && blueprint.name.length > 0, "make: blueprint has no name");
  check(Array.isArray(blueprint.flow) && blueprint.flow.length > 0, "make: empty flow");
  check(blueprint.metadata?.instant === true, "make: a webhook scenario must be marked instant");
  check(blueprint.metadata?.scenario?.dlq === true, "make: turn on the dead-letter queue so failed runs are recoverable");
  check(
    blueprint.metadata?.scenario?.sequential === true,
    "make: sequential processing, or two submissions can race for the same client ID",
  );

  const modules: MakeModule[] = [];
  const topLevel: MakeModule[] = [];
  walk(blueprint.flow, (mod, inErrorHandler) => {
    modules.push(mod);
    if (!inErrorHandler) topLevel.push(mod);
  });

  const ids = modules.map((module) => module.id);
  check(new Set(ids).size === ids.length, "make: duplicate module ids");

  for (const mod of modules) {
    check(typeof mod.module === "string", `make: module ${mod.id} has no module type`);
    check(
      Boolean(mod.metadata?.designer?.name),
      `make: module ${mod.id} has no name — an unnamed module is unreadable in the editor`,
    );
  }

  const trigger = blueprint.flow[0];
  check(trigger?.module === "gateway:CustomWebHook", "make: the first module should be the webhook trigger");

  const router = blueprint.flow.find((module) => module.module === "builtin:BasicRouter");
  check(Boolean(router), "make: no validation router");
  check((router?.routes?.length ?? 0) >= 2, "make: the router needs a fallback route for invalid submissions");

  // Every Google module on the main path must have somewhere for a failure to go.
  for (const mod of topLevel) {
    if (!/^google-/.test(mod.module ?? "")) continue;
    const name = mod.metadata?.designer?.name ?? String(mod.id);
    check(Array.isArray(mod.onerror) && mod.onerror.length > 0, `make: "${name}" has no error handler`);
  }

  const appendRow = modules.find((module) => module.metadata?.designer?.name?.includes("Add row to tracker"));
  check(Boolean(appendRow), "make: no 'Add row to tracker' module");
  check(
    appendRow?.onerror?.[0]?.module === "builtin:Break",
    "make: the tracker row must use Break, so a failed run is parked and retried rather than dropped",
  );
}

/* ------------------------------------------------------------- cross-checks ---- */

/**
 * The exports and the reference implementation must describe the same workflow. Each
 * step declares the module it maps to; if a step is added here and the exports are not
 * updated, the client ends up with a scenario that does less than the documentation says.
 */
function validateParity(): void {
  const makeRaw = readFileSync(join(root, "make/blueprint.json"), "utf8");
  const n8nRaw = readFileSync(join(root, "n8n/workflow.json"), "utf8");

  const expected: Record<string, { make: RegExp; n8n: RegExp }> = {
    validate: { make: /Is it usable\?/, n8n: /Is it usable\?/ },
    "assign-id": { make: /Assign a client ID/, n8n: /Assign a client ID/ },
    "append-row": { make: /Add row to tracker/, n8n: /Add row to tracker/ },
    "create-folder": { make: /Create client folder/, n8n: /Create client folder/ },
    "create-subfolders": { make: /Subfolder 01/, n8n: /Create subfolders/ },
    "link-folder": { make: /Write the folder link/, n8n: /Write the folder link/ },
    notify: { make: /Email the studio/, n8n: /Email the studio/ },
  };

  for (const step of STEPS) {
    const pattern = expected[step.id];
    if (!pattern) {
      failures.push(`parity: step "${step.id}" has no counterpart declared — add it to both exports and to this script`);
      continue;
    }
    check(pattern.make.test(makeRaw), `parity: step "${step.id}" is missing from make/blueprint.json`);
    check(pattern.n8n.test(n8nRaw), `parity: step "${step.id}" is missing from n8n/workflow.json`);
  }

  check(
    Object.keys(expected).length === STEPS.length,
    `parity: ${Object.keys(expected).length} mappings declared but ${STEPS.length} steps exist`,
  );
}

/* --------------------------------------------------------------------- main ---- */

validateN8n();
validateMake();
validateParity();

for (const note of notes) console.warn(`note  ${note}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? "" : "s"} with the exported workflows:\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`Workflows look sound: ${STEPS.length} steps present in both exports, error routes and retries in place.`);
