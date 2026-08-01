import { deriveSituationStatus } from "@situation-studio/domain";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import {
  SituationInventory,
  type InventoryItem,
} from "@/components/situation-inventory";
import { requireSession } from "@/server/auth/request";
import { database } from "@/server/database";
import { reconcileLeadershipRelease } from "@/server/leadership-sync";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await requireSession("/");
  await reconcileLeadershipRelease();
  const [situations, globalRecoveryRequired] = await Promise.all([
    database().situation.findMany({
      orderBy: { title: "asc" },
      include: {
        checkouts: {
          where: { releasedAt: null },
          include: { holder: { select: { id: true, displayName: true } } },
        },
        drafts: {
          where: { state: "ACTIVE" },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        reviewJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
        publicationJobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    database().publicationJob.findFirst({
      where: { state: "RECOVERY_REQUIRED" },
      select: { id: true },
    }),
  ]);
  const inventory: InventoryItem[] = situations.map((situation) => {
    const checkout = situation.checkouts[0];
    const draft = situation.drafts[0];
    const review = situation.reviewJobs[0];
    const publication = situation.publicationJobs[0];
    const activity =
      publication?.state === "RECOVERY_REQUIRED"
        ? "Recovery required"
        : publication?.state === "RESTORED"
          ? "Publish failed — previous production restored"
          : publication &&
              ["REQUESTED", "ASSEMBLING", "PROMOTING", "VERIFYING"].includes(
                publication.state,
              )
            ? "Publishing"
            : draft?.conflictedAt
              ? "Needs refresh"
              : review?.state === "RUNNING"
                ? "Review running"
                : review?.state === "QUEUED"
                  ? "Review queued"
                  : null;
    const status = deriveSituationStatus({
      visibility: situation.visibility,
      checkoutOwner: checkout?.holder.displayName ?? null,
      draftBundleHash: draft?.currentBundleHash ?? null,
      productionBundleHash: situation.productionBundleHash,
      activity,
    });
    return {
      id: situation.id,
      slug: situation.slug,
      title: situation.title,
      primary: status.primary,
      activity: status.activity,
      checkoutOwner: checkout?.holder.displayName ?? null,
      checkoutOwnerId: checkout?.holder.id ?? null,
      draftUpdatedAt: draft?.updatedAt.toISOString() ?? null,
      productionAt: situation.productionAt?.toISOString() ?? null,
    };
  });
  return (
    <AppShell
      active="situations"
      csrfToken={session.csrfToken}
      user={{
        displayName: session.user.displayName,
        isAdmin: session.roles.has("ADMIN"),
      }}
    >
      <main className="inventoryPage">
        <header className="pageIntro">
          <div>
            <p className="eyebrow">Editorial inventory</p>
            <h1 id="inventory-heading">
              Choose one situation to move forward.
            </h1>
            <p>
              The normal path stays small: check out, edit or run a review, then
              submit.
            </p>
          </div>
          {globalRecoveryRequired ? (
            <span className="primaryButton" aria-disabled="true">
              New situation
            </span>
          ) : (
            <Link className="primaryButton" href="/situations/new">
              New situation
            </Link>
          )}
        </header>
        <div
          className="inventorySummary"
          aria-label="Situation summary"
          tabIndex={0}
        >
          <span>
            <strong>{inventory.length}</strong> situations
          </span>
          <span>
            <strong>
              {inventory.filter((item) => item.checkoutOwnerId).length}
            </strong>{" "}
            checked out
          </span>
          <span>
            <strong>
              {
                inventory.filter((item) => item.primary === "Draft saved")
                  .length
              }
            </strong>{" "}
            drafts waiting
          </span>
          <span
            className={`productionSignal${globalRecoveryRequired ? " productionSignalError" : ""}`}
          >
            <i aria-hidden="true" />
            {globalRecoveryRequired
              ? "Leadership recovery required"
              : "Leadership observation healthy"}
          </span>
        </div>
        <SituationInventory
          items={inventory}
          currentUserId={session.userId}
          csrfToken={session.csrfToken}
          globalRecoveryRequired={Boolean(globalRecoveryRequired)}
        />
      </main>
    </AppShell>
  );
}
