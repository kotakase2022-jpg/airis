"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items }: { items: { key: string; label: string; href: string }[] }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              className={`relative flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                active
                  ? "bg-blue-50 text-blue-700"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r bg-blue-600" />
              )}
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
