import { describe, expect, it } from "vitest";
import {
  bootstrapLegacyAliases,
  bootstrapLegacyRetirements,
  matchesBootstrapLegacyAlias,
  matchesBootstrapLegacyPathMove,
  matchesBootstrapLegacyRetirement,
} from "../src/database-bootstrap-legacy";

describe("production bootstrap legacy registry transition", () => {
  it("adopts only the five exact same-path logical ID aliases", () => {
    expect(bootstrapLegacyAliases).toHaveLength(5);
    const alias = bootstrapLegacyAliases[0];
    expect(alias).toBeDefined();
    expect(
      matchesBootstrapLegacyAlias(
        {
          logicalId: alias!.canonicalLogicalId,
          canonicalPath: alias!.canonicalPath,
          type: alias!.type,
        },
        {
          logicalId: alias!.legacyLogicalId,
          canonicalPath: alias!.canonicalPath,
          type: alias!.type,
        },
      ),
    ).toBe(true);
    expect(
      matchesBootstrapLegacyAlias(
        {
          logicalId: alias!.canonicalLogicalId,
          canonicalPath: alias!.canonicalPath,
          type: alias!.type,
        },
        {
          logicalId: "unknown:artifact",
          canonicalPath: alias!.canonicalPath,
          type: alias!.type,
        },
      ),
    ).toBe(false);
  });

  it("retires only the eight exact legacy registry identities", () => {
    expect(bootstrapLegacyRetirements).toHaveLength(8);
    const retirement = bootstrapLegacyRetirements[0];
    expect(retirement).toBeDefined();
    expect(matchesBootstrapLegacyRetirement(retirement!)).toBe(true);
    expect(
      matchesBootstrapLegacyRetirement({
        logicalId: retirement!.logicalId,
        canonicalPath: `${retirement!.canonicalPath}-unexpected`,
        type: retirement!.type,
      }),
    ).toBe(false);
    expect(
      matchesBootstrapLegacyRetirement({
        logicalId: retirement!.logicalId,
        canonicalPath: retirement!.canonicalPath,
        type: "VALIDATOR",
      }),
    ).toBe(false);
  });

  it("allows only the reviewed tool catalog path move", () => {
    expect(
      matchesBootstrapLegacyPathMove(
        {
          logicalId: "tool:catalog",
          canonicalPath: "content/tools/tools.json",
          type: "TOOL",
        },
        {
          logicalId: "tool:catalog",
          canonicalPath: "lib/tools.ts",
          type: "TOOL",
        },
      ),
    ).toBe(true);
    expect(
      matchesBootstrapLegacyPathMove(
        {
          logicalId: "tool:catalog",
          canonicalPath: "content/tools/tools.json",
          type: "TOOL",
        },
        {
          logicalId: "tool:catalog",
          canonicalPath: "unexpected/tools.ts",
          type: "TOOL",
        },
      ),
    ).toBe(false);
  });
});
