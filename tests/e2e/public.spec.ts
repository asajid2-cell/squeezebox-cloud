import { expect, test } from "@playwright/test";

test("public site renders the console layout and core actions", async ({ page }) => {
  await page.goto("/");
  // Brand wordmark in the nav rail; the page-level h1 stays screen-reader-only.
  await expect(page.locator(".brand")).toContainText("Squeezebox Cloud");
  await expect(page.getByLabel("Now playing")).toBeVisible();
  await expect(page.getByLabel("Up next")).toBeVisible();
  await expect(page.getByLabel("Track information")).toBeVisible();
  // The persistent player bar owns transport on every screen.
  await expect(page.getByRole("contentinfo", { name: "Player" })).toBeVisible();
  await expect(page.getByText(/Speaker (online|offline)|Reconnecting/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request song" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Schedule" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Room" })).toHaveCount(0);
  await expect(page.getByText("Public speaker queue")).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("region", { name: "Library" })).toBeVisible();
  await expect(page.getByPlaceholder("Search local library")).toHaveCount(0);
  // Transport is still reachable from the Library screen (the flagship contract).
  await expect(page.getByRole("contentinfo", { name: "Player" })).toBeVisible();
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByLabel("Up next")).toBeVisible();
});

test("admin route requires login before service controls", async ({ page }) => {
  const adminPassword = process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin";
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin Console" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin login" })).toBeVisible();
  await page.getByLabel("Admin password").fill(adminPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Connect speaker" })).toBeVisible();
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByText("192.168.1.142", { exact: true })).toBeVisible();
  await expect(page.getByText("Service providers")).toBeVisible();
  await expect(page.getByText("Local library")).toBeVisible();
});
