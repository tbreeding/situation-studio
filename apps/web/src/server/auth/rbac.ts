import {
  effectivePermissions,
  type Permission,
  type RoleCode,
} from "@situation-studio/domain";
import { database } from "@/server/database";

export async function permissionsForUser(
  userId: string,
): Promise<Set<Permission>> {
  const [assignments, grants] = await Promise.all([
    database().userRoleAssignment.findMany({
      where: { userId },
      include: { role: true },
    }),
    database().userPermissionGrant.findMany({
      where: { userId },
      include: { permission: true },
    }),
  ]);
  return effectivePermissions(
    assignments.map((item) => item.role.code as RoleCode),
    grants.map((item) => item.permission.code as Permission),
  );
}

export async function requirePermission(
  userId: string,
  permission: Permission,
): Promise<Set<Permission>> {
  const permissions = await permissionsForUser(userId);
  if (!permissions.has(permission)) throw new Error("FORBIDDEN");
  return permissions;
}
