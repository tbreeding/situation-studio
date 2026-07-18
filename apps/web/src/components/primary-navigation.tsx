"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const destinations = [
  {
    href: "/",
    label: "Situations",
    matches: (path: string) => path === "/" || path.startsWith("/situations/"),
  },
  { href: "/jobs", label: "Jobs", matches: (path: string) => path === "/jobs" },
  {
    href: "/capacity",
    label: "Capacity",
    matches: (path: string) => path === "/capacity",
  },
] as const;

export function PrimaryNavigation({
  canAccessAdministration,
}: {
  canAccessAdministration: boolean;
}) {
  const pathname = usePathname();
  const links = canAccessAdministration
    ? [
        ...destinations,
        {
          href: "/administration",
          label: "Administration",
          matches: (path: string) => path === "/administration",
        },
      ]
    : destinations;

  return (
    <nav aria-label="Primary">
      {links.map((item) => {
        const current = item.matches(pathname);
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={current ? "active" : undefined}
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
