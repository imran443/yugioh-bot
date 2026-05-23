import { LayoutDashboard, Trophy, Medal, Layers, Boxes, Settings, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: "exact" | "prefix";
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, match: "exact" },
  { href: "/tournaments", label: "Tournaments", icon: Trophy, match: "prefix" },
  { href: "/drafts", label: "Drafts", icon: Layers, match: "prefix" },
  { href: "/cubes", label: "My Cubes", icon: Boxes, match: "prefix" },
  { href: "/leaderboard", label: "Leaderboard", icon: Medal, match: "exact" },
  { href: "/settings", label: "Settings", icon: Settings, match: "exact" },
];
