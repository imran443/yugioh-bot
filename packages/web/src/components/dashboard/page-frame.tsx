import type { ReactNode } from "react";
import { OwnsPageBar, ShellMenuButton } from "@/components/layout/shell-bar";
import { PageBar, SheetRoot, type PageBarProps } from "@/components/sheet";
import styles from "./page-frame.module.css";

/**
 * A Solid Vision page: the sheet root on the floor, the page bar edge to edge across the top, then
 * the page body with its own side padding. `OwnsPageBar` tells the shell to hide its phone bar and
 * drop its padding, and the shell's menu button goes last in the bar's actions so the phone keeps a
 * menu. Used by the tournaments, dashboard, leaderboard and player pages.
 */
export function PageFrame({
  children,
  bodyClassName,
  actions,
  ...bar
}: Pick<PageBarProps, "title" | "sub" | "back" | "actions" | "titleAs"> & { children: ReactNode; bodyClassName?: string }) {
  return (
    <SheetRoot className={styles.root}>
      <OwnsPageBar room />
      <PageBar {...bar} actions={<>{actions}<ShellMenuButton /></>} />
      <div className={bodyClassName ? `${styles.body} ${bodyClassName}` : styles.body}>{children}</div>
    </SheetRoot>
  );
}
