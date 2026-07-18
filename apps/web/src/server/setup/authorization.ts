import {
  permissions,
  rolePermissions,
  type RoleCode,
} from "@situation-studio/domain";
import type { DatabaseClient } from "@situation-studio/db";

const descriptions: Record<(typeof permissions)[number], string> = {
  "situation.create": "Create a situation identity and initial discovery draft",
  "draft.update": "Acquire an editing checkout and mutate drafts",
  "ai.run": "Run focused or complete AI review workflows",
  "proposal.review": "Review proposals, comments, and change decisions",
  "publication.approve": "Approve an exact validated bundle",
  "publication.publish": "Stage, publish, reconcile, and roll back",
  "situation.archive": "Archive or restore a situation",
  "user.manage": "Create, activate, deactivate, reset, and grant users",
  "system.admin":
    "Administer providers, queues, incidents, and forced checkout actions",
};

export async function seedAuthorization(database: DatabaseClient) {
  for (const permission of permissions) {
    await database.permission.upsert({
      where: { code: permission },
      create: { code: permission, description: descriptions[permission] },
      update: { description: descriptions[permission] },
    });
  }
  for (const code of Object.keys(rolePermissions) as RoleCode[]) {
    const role = await database.role.upsert({
      where: { code },
      create: {
        code,
        displayName: code
          .toLowerCase()
          .replaceAll("_", " ")
          .replace(/^./u, (value) => value.toUpperCase()),
      },
      update: {},
    });
    for (const permissionCode of rolePermissions[code]) {
      const permission = await database.permission.findUniqueOrThrow({
        where: { code: permissionCode },
      });
      await database.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        create: { roleId: role.id, permissionId: permission.id },
        update: {},
      });
    }
  }
}
