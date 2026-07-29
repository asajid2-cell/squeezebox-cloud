import { expect, test } from "@playwright/test";

test("public site renders Potential C layout and core actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Squeezebox Cloud")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Squeezebox Cloud" })).toHaveCount(0);
  await expect(page.getByLabel("Now playing")).toBeVisible();
  await expect(page.getByLabel("Up next")).toBeVisible();
  await expect(page.getByLabel("Track information")).toBeVisible();
  await expect(page.getByText(/Speaker (online|offline)/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request song" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Schedule" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Room" })).toHaveCount(0);
  await expect(page.getByText("Public speaker queue")).toHaveCount(0);
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.getByRole("region", { name: "Library" })).toBeVisible();
  await expect(page.getByPlaceholder("Search local library")).toHaveCount(0);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByLabel("Up next")).toBeVisible();
});

test("admin route requires login before service controls", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin Console" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin login" })).toBeVisible();
  await page.getByLabel("Admin password").fill("admin");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Connect speaker" })).toBeVisible();
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByText("192.168.1.142", { exact: true })).toBeVisible();
  await expect(page.getByText("Service providers")).toBeVisible();
  await expect(page.getByText("Local library")).toBeVisible();
  await expect(page.getByText("Screen audit")).toBeVisible();
});
