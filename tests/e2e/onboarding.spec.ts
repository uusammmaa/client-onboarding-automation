import { expect, test, type Page } from "@playwright/test";

/**
 * The desk, driven the way a visitor drives it.
 *
 * These cover the two things a client evaluating this actually clicks: send a brief and
 * watch it land on the tracker, then break something and check the workflow says
 * something useful rather than "an error occurred".
 */

async function fillExample(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Fill with an example" }).click();
  await expect(page.getByLabel("Company")).toHaveValue("Wilder & Co");
}

async function send(page: Page) {
  await page.getByRole("button", { name: "Send the brief" }).click();
  await expect(page.getByRole("button", { name: "Send the brief" })).toBeEnabled();
}

test.describe("client onboarding", () => {
  test("says which adapters are wired", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Sheets: (demo|live)/)).toBeVisible();
    await expect(page.getByText(/Drive: (demo|live)/)).toBeVisible();
    await expect(page.getByText(/Gmail: (demo|live)/)).toBeVisible();
  });

  test("onboards a client and puts them on the tracker", async ({ page }) => {
    await fillExample(page);
    await send(page);

    await expect(page.getByText("All seven steps ran")).toBeVisible();

    const log = page.getByRole("region", { name: "Run log" });
    for (const step of [
      "Validate the submission",
      "Assign a client ID",
      "Add a row to the tracker",
      "Create the client folder",
      "Create the working subfolders",
      "Put the folder link on the row",
      "Email the studio",
    ]) {
      // Not exact: each label carries a screen-reader-only outcome suffix beside it.
      await expect(log.getByText(step)).toBeVisible();
    }

    const tracker = page.getByRole("region", { name: "Client tracker" });
    await expect(tracker.getByText("Wilder & Co")).toBeVisible();
    await expect(tracker.getByRole("row")).toHaveCount(7); // header + 6
  });

  test("names the Make module beside every step", async ({ page }) => {
    await fillExample(page);
    await send(page);

    const log = page.getByRole("region", { name: "Run log" });
    await expect(log.getByText(/Module 4 · Google Sheets/)).toBeVisible();
    await expect(log.getByText(/Module 11 · Gmail/)).toBeVisible();
  });

  test("updates the ledger totals", async ({ page }) => {
    await page.goto("/");
    const ledger = page.getByRole("region", { name: "Ledger summary" });
    await expect(ledger.getByText("£55,000")).toBeVisible();

    await page.getByRole("button", { name: "Fill with an example" }).click();
    await send(page);

    // The example is £6,500, and none of it is paid yet.
    await expect(ledger.getByText("£61,500")).toBeVisible();
  });

  test("retries a transient failure and still succeeds", async ({ page }) => {
    await fillExample(page);
    await page.getByLabel("Break something on purpose").selectOption("drive_quota");
    await send(page);

    await expect(page.getByText("All seven steps ran")).toBeVisible();
    const log = page.getByRole("region", { name: "Run log" });
    await expect(log.getByText(/Attempt 1 — drive\.rateLimit/)).toBeVisible();
    await expect(log.getByText(/waited \d+ ms before trying again/)).toBeVisible();
  });

  test("keeps the client and asks for help when Drive is misconfigured", async ({ page }) => {
    await fillExample(page);
    await page.getByLabel("Break something on purpose").selectOption("drive_permission");
    await send(page);

    await expect(page.getByText("Onboarded, but something needs a person")).toBeVisible();
    await expect(page.getByText(/Check DRIVE_CLIENTS_FOLDER_ID/)).toBeVisible();

    // The client is still on the tracker; that is the whole point.
    await expect(page.getByRole("region", { name: "Client tracker" }).getByText("Wilder & Co")).toBeVisible();
  });

  test("writes nothing at all when the Sheet is not shared", async ({ page }) => {
    await fillExample(page);
    await page.getByLabel("Break something on purpose").selectOption("sheets_permission");
    await send(page);

    await expect(page.getByText("Nothing was saved")).toBeVisible();
    await expect(page.getByText(/Share the tracker spreadsheet/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Client tracker" }).getByText("Wilder & Co")).toHaveCount(0);
  });

  test("shows field errors rather than a generic complaint", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Your name").fill("A");
    // getByLabel("Email") would also match the marketing-consent checkbox.
    await page.getByRole("textbox", { name: "Email" }).fill("not-an-email");
    await page.getByRole("button", { name: "Send the brief" }).click();

    await expect(page.getByText("That email address does not look right")).toBeVisible();
    // Nothing should have been sent.
    await expect(page.getByText(/steps ran|Nothing was saved/)).toHaveCount(0);
  });

  test("survives a reload with the submission intact", async ({ page }) => {
    await fillExample(page);
    await send(page);
    await expect(page.getByRole("region", { name: "Client tracker" }).getByText("Wilder & Co")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("region", { name: "Client tracker" }).getByText("Wilder & Co")).toBeVisible();

    await page.getByRole("button", { name: "Reset the demo" }).click();
    await expect(page.getByRole("region", { name: "Client tracker" }).getByText("Wilder & Co")).toHaveCount(0);
  });

  test("lays out without horizontal overflow", async ({ page }) => {
    await fillExample(page);
    await send(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("rejects a malformed API call", async ({ request }) => {
    const response = await request.post("/api/intake", { data: { intake: { company: "x" } } });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: string; fields: Array<{ path: string }> };
    expect(body.error).toMatch(/not valid/i);
    expect(body.fields.length).toBeGreaterThan(0);
  });

  test("health endpoint describes the workflow", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { workflow: { steps: unknown[]; sheetColumns: number } };
    expect(body.workflow.steps).toHaveLength(7);
    expect(body.workflow.sheetColumns).toBe(21);
  });
});
