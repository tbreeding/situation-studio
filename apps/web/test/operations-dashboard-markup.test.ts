import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { OperationsDashboard } from "../src/components/operations-dashboard";

describe("Operations account form markup", () => {
  it("keeps existing login credentials out of the new-account fields", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        users: [],
        checkouts: [],
        csrfToken: "csrf-token",
      }),
    );

    expect(markup).toMatch(
      /<form(?=[^>]*class="createUserForm")(?=[^>]*autoComplete="off")[^>]*>/u,
    );
    expect(markup).toMatch(
      /<input(?=[^>]*name="new-username")(?=[^>]*autoComplete="off")[^>]*>/u,
    );
    expect(markup).toMatch(
      /<input(?=[^>]*name="display-name")(?=[^>]*autoComplete="off")[^>]*>/u,
    );
    expect(markup).toMatch(
      /<input(?=[^>]*type="password")(?=[^>]*name="new-password")(?=[^>]*autoComplete="new-password")[^>]*>/u,
    );
  });
});
