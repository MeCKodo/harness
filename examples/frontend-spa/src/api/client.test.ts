import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson } from "./client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getJson", () => {
  it("uses the configured API base URL", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJson("/health")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/health");
  });
});
