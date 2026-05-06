"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/nav-items";

interface SidebarProps {
  collapsed: boolean;
}

export function Sidebar({ collapsed }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={`hidden md:flex md:flex-col md:fixed md:top-14 md:bottom-0 md:left-0 md:border-r md:border-border md:bg-bg-surface md:z-30 motion-safe:transition-[width] duration-200 ${
        collapsed ? "md:w-16" : "md:w-56"
      }`}
    >
      <nav className="sidebar-nav flex-1 space-y-1 px-3 py-4" aria-label="Main navigation">
        {navItems.map((item) => {
          const isActive =
            item.match === "exact"
              ? pathname === item.href
              : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 font-body text-sm font-semibold motion-safe:transition-colors ${
                collapsed ? "justify-center" : ""
              } ${
                isActive
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
              }`}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className={`sidebar-label ${collapsed ? "sr-only" : ""}`}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}