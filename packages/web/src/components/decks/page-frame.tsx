import type { HTMLAttributes, ReactNode } from "react";
import { OwnsPageBar, ShellMenuButton } from "@/components/layout/shell-bar";
import { PageBar, SheetRoot, type PageBarProps } from "@/components/sheet";
import styles from "./page-frame.module.css";

/**
 * A Solid Vision page for the cube and deck lists and the cube editor: the sheet root on the floor,
 * the page bar edge to edge, then a padded body. `OwnsPageBar` tells the shell to drop its own
 * phone bar and padding, and the shell's menu button goes last in the bar so the phone keeps a menu.
 */
export function PageFrame({
  children,
  actions,
  bodyClassName,
  title,
  sub,
  back,
  ...rest
}: Pick<PageBarProps, "title" | "sub" | "back" | "actions"> & { children: ReactNode; bodyClassName?: string } & Omit<HTMLAttributes<HTMLElement>, "title" | "children">) {
  return (
    <SheetRoot className={styles.root} {...rest}>
      <OwnsPageBar room />
      <PageBar title={title} sub={sub} back={back} actions={<>{actions}<ShellMenuButton /></>} />
      <div className={bodyClassName ? `${styles.body} ${bodyClassName}` : styles.body}>{children}</div>
    </SheetRoot>
  );
}

/** The same frame while a page loads, so the padding does not jump when the real page arrives. */
export function PageFrameFallback({ title, label }: { title: string; label: string }) {
  return (
    <PageFrame title={title}>
      <p className={styles.quiet} role="status">{label}</p>
    </PageFrame>
  );
}
