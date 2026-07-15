import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard } from ".";

describe("Dashboard", () => {
  it("renders the user-visible heading", () => {
    expect(renderToStaticMarkup(<Dashboard />)).toContain("Acme Dashboard");
  });
});
