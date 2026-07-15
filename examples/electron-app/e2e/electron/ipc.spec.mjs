import { _electron as electron, expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const mainEntry = fileURLToPath(new URL("../../electron/main/index.cjs", import.meta.url));

test("real Electron crosses preload and notes:list IPC", async () => {
  const app = await electron.launch({ args: [mainEntry] });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "Desktop Notes" })).toBeVisible();
    await expect.poll(() => window.evaluate(() => typeof window.desktopNotes?.list)).toBe("function");
    await window.getByRole("button", { name: "Load notes" }).click();
    await expect(window.getByRole("listitem")).toHaveText("Inbox note (inbox)");
  } finally {
    await app.close();
  }
});
