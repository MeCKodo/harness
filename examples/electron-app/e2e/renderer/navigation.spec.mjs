import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rendererRoot = fileURLToPath(new URL("../../src/renderer/", import.meta.url));
let server;
let baseURL;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const file = request.url === "/app.js" ? "app.js" : "index.html";
    response.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(readFileSync(`${rendererRoot}${file}`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("renderer loads notes through the user-visible bridge", async ({ page }) => {
  await page.addInitScript(() => {
    window.desktopNotes = { list: async () => [{ id: "browser", title: "Browser note" }] };
  });
  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Desktop Notes" })).toBeVisible();
  await page.getByRole("button", { name: "Load notes" }).click();
  await expect(page.getByRole("listitem")).toHaveText("Browser note");
});
