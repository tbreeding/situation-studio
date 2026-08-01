import { describe, expect, it } from "vitest";
import { proposalPreservesManagedMdxComponents } from "../src/server/workflows/situations";

describe("automatic proposal component safety", () => {
  const practiceEmbed =
    '<PracticeEmbed practiceId="listen-first" variant="feedback-defensiveness" surface="situation" compact />';
  const preparedAction =
    '<PreparedAction scenario="defensive-about-feedback" skill="feedback" />';

  it("allows prose edits that preserve ordered managed component tags exactly", () => {
    expect(
      proposalPreservesManagedMdxComponents(
        `Practice the conversation.\n\n${practiceEmbed}`,
        `Rehearse the conversation aloud.\n\n${practiceEmbed}`,
      ),
    ).toBe(true);
  });

  it("rejects removing or changing a managed component attribute", () => {
    expect(
      proposalPreservesManagedMdxComponents(
        practiceEmbed,
        '<PracticeEmbed practiceId="listen-first" surface="situation" compact />',
      ),
    ).toBe(false);
    expect(
      proposalPreservesManagedMdxComponents(
        preparedAction,
        '<PreparedAction scenario="defensive-about-feedback" skill="coaching" />',
      ),
    ).toBe(false);
    expect(
      proposalPreservesManagedMdxComponents(
        practiceEmbed,
        '<PracticeEmbed practiceId="listen-first" variant="feedback-defensiveness" surface="situation"></PracticeEmbed>',
      ),
    ).toBe(false);
  });

  it("rejects adding or reordering managed components", () => {
    expect(
      proposalPreservesManagedMdxComponents(
        "No component here.",
        practiceEmbed,
      ),
    ).toBe(false);
    expect(
      proposalPreservesManagedMdxComponents(
        "No component here.",
        '<PracticeEmbed practiceId="listen-first" variant="feedback-defensiveness" surface="situation"></PracticeEmbed>',
      ),
    ).toBe(false);
    expect(
      proposalPreservesManagedMdxComponents(
        `${practiceEmbed}\n\n${preparedAction}`,
        `${preparedAction}\n\n${practiceEmbed}`,
      ),
    ).toBe(false);
  });
});
