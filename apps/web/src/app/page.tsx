import { redirect } from "next/navigation";
import matter from "gray-matter";
import { AppShell } from "@/components/app-shell";
import {
  SituationInventory,
  type InventorySituation,
} from "@/components/situation-inventory";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";

export default async function SituationsPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  const situations = await database().situation.findMany({
    orderBy: { title: "asc" },
    include: {
      checkouts: {
        where: { releasedAt: null },
        include: { holder: true },
        take: 1,
      },
      drafts: {
        where: { active: true },
        take: 1,
        include: {
          revisions: {
            orderBy: { revision: "desc" },
            take: 1,
            include: {
              artifacts: { include: { artifact: true, content: true } },
            },
          },
          bundles: {
            where: { state: { notIn: ["STALE", "PUBLISHED"] } },
            orderBy: { revision: "desc" },
            take: 1,
            include: {
              validations: true,
              publicationRequests: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
        },
      },
      currentPublication: {
        include: {
          version: {
            include: {
              artifacts: { include: { artifact: true, content: true } },
            },
          },
        },
      },
    },
  });
  const inventory: InventorySituation[] = situations.map((situation) => {
    const checkout = situation.checkouts[0] ?? null;
    const draft = situation.drafts[0] ?? null;
    const bundle = draft?.bundles[0] ?? null;
    const logicalId = `situation:${situation.slug}`;
    const body =
      draft?.revisions[0]?.artifacts.find(
        (item) => item.artifact.logicalId === logicalId,
      )?.content.body ??
      situation.currentPublication?.version?.artifacts.find(
        (item) => item.artifact.logicalId === logicalId,
      )?.content.body ??
      "";
    let primarySkill = "unclassified";
    let tags: string[] = [];
    try {
      const metadata = matter(body).data as {
        primarySkill?: unknown;
        tags?: unknown;
      };
      if (typeof metadata.primarySkill === "string")
        primarySkill = metadata.primarySkill;
      if (Array.isArray(metadata.tags))
        tags = metadata.tags.filter(
          (tag): tag is string => typeof tag === "string",
        );
    } catch {
      // Inventory remains usable if a draft contains temporarily invalid frontmatter.
    }
    const validationBlocked =
      bundle?.validations.some((item) => item.state === "FAILED") ?? false;
    const publicationPending = Boolean(
      bundle?.publicationRequests.some(
        (item) =>
          !["LIVE_VERIFIED", "RECONCILED", "AUTO_ROLLED_BACK"].includes(
            item.state,
          ),
      ),
    );
    const needsAttention = Boolean(
      checkout ||
      draft ||
      situation.lifecycle === "ARCHIVED" ||
      situation.publicationState !== "PUBLISHED" ||
      validationBlocked ||
      publicationPending,
    );
    return {
      id: situation.id,
      slug: situation.slug,
      title: situation.title,
      lifecycle: situation.lifecycle,
      publicationState: situation.publicationState,
      primarySkill,
      tags,
      checkout: checkout
        ? {
            mode: checkout.mode,
            holderName: checkout.holder?.displayName ?? "a server job",
            renewedAt: checkout.renewedAt.toISOString(),
          }
        : null,
      draftState: draft?.state ?? null,
      proposalState: bundle?.state ?? null,
      validationBlocked,
      publicationPending,
      needsAttention,
    };
  });
  return (
    <AppShell
      user={session.user}
      csrfToken={session.csrfToken}
      canAccessAdministration={session.permissions.has("system.admin")}
    >
      <section className="pageIntro compactIntro">
        <div>
          <p className="eyebrow">Leadership content operations</p>
          <h1>One rule. Every learning surface.</h1>
        </div>
        <p className="muted">
          Work from the exact published baseline, see the complete blast radius,
          and move one immutable bundle through challenge, human review,
          validation, preview, and publication.
        </p>
      </section>
      <div className="policyBanner">
        <span>
          <strong>Sensitive-data boundary:</strong> use synthetic or anonymized
          workplace context only. Never enter PII, credentials, customer
          secrets, health data, or identifiable employee details.
        </span>
        <span className="badge rust">Private beta</span>
      </div>
      <SituationInventory
        situations={inventory}
        canCreate={session.permissions.has("situation.create")}
      />
    </AppShell>
  );
}
