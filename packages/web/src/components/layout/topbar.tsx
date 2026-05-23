"use client";

import { useState, useRef, useEffect } from "react";
import { handleSignOut } from "@/lib/actions";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu, LogOut, PanelLeftClose, PanelLeft, User } from "lucide-react";

interface TopBarProps {
  onMenuClick: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

export function TopBar({ onMenuClick, onToggleSidebar, sidebarCollapsed }: TopBarProps) {
  const pathname = usePathname();
  const [session, setSession] = useState<{
    user?: { name?: string | null; image?: string | null };
  } | null>(null);
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then(setSession)
      .catch(() => {});
    fetch("/api/player/me")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.playerId) setPlayerId(d.playerId); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  let pageTitle = "Yu-Gi-Oh! TM";

  if (pathname === "/dashboard") {
    pageTitle = "Dashboard";
  } else if (pathname === "/tournaments") {
    pageTitle = "Tournaments";
  } else if (pathname.startsWith("/tournament")) {
    pageTitle = "Tournament";
  } else if (pathname.startsWith("/draft")) {
    pageTitle = "Draft";
  } else if (pathname === "/login") {
    pageTitle = "Sign In";
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center border-b border-border bg-bg-surface px-4">
      <button
        type="button"
        className="mr-2 hidden h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-elevated hover:text-text-primary motion-safe:transition-colors md:flex"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {sidebarCollapsed ? (
          <PanelLeft className="h-5 w-5" />
        ) : (
          <PanelLeftClose className="h-5 w-5" />
        )}
      </button>

      <button
        type="button"
        className="mr-2 flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-elevated hover:text-text-primary md:hidden"
        onClick={onMenuClick}
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      <h1 className="font-display text-lg text-text-primary md:hidden">
        {pageTitle}
      </h1>

      <div className="ml-auto flex items-center gap-3" ref={dropdownRef}>
        {session?.user ? (
          <div className="relative">
            <button
              type="button"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-elevated motion-safe:transition-colors"
              onClick={() => setDropdownOpen(!dropdownOpen)}
              aria-expanded={dropdownOpen}
              aria-haspopup="true"
            >
              {session.user.image ? (
                <img
                  src={session.user.image}
                  alt={session.user.name ?? "User avatar"}
                  className="h-8 w-8 rounded-full"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-primary/20 text-sm font-semibold text-accent-primary">
                  {(session.user.name ?? "U")[0].toUpperCase()}
                </div>
              )}
              <span className="hidden text-sm font-medium text-text-primary sm:block">
                {session.user.name}
              </span>
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border bg-bg-surface shadow-card">
                <div className="px-3 py-2 text-xs text-text-muted">
                  {session.user.name}
                </div>
                <div className="border-t border-border" />
                {playerId !== null && (
                  <Link
                    href={`/player/${playerId}`}
                    onClick={() => setDropdownOpen(false)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-elevated hover:text-text-primary motion-safe:transition-colors"
                  >
                    <User className="h-4 w-4" />
                    My Profile
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDropdownOpen(false);
                    void handleSignOut();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-elevated hover:text-text-primary motion-safe:transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <Link
            href="/login"
            className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:bg-accent-secondary motion-safe:transition-colors"
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
