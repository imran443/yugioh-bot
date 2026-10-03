import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { BugFabLift } from "@/components/bug-report/fab-lift";
import { OwnsPageBar, ShellMenuButton } from "@/components/layout/shell-bar";
import { PageBar, SheetRoot, type PageBarProps } from "@/components/sheet";
import { cn } from "@/lib/utils";
import styles from "./draft-frame.module.css";

/**
 * A drafts page in Solid Vision: the sheet root on the floor, the page bar edge to edge across the top, then the
 * page body with its own side padding. `OwnsPageBar` tells the shell to hide its phone bar and drop its padding, and
 * the shell's menu button goes last in the bar's actions so the phone keeps a menu.
 */
export function DraftFrame({
  children,
  bodyClassName,
  actions,
  ...bar
}: Pick<PageBarProps, "title" | "sub" | "back" | "actions" | "titleAs"> & { children: ReactNode; bodyClassName?: string }) {
  return (
    <SheetRoot className={styles.root}>
      <OwnsPageBar room />
      <PageBar {...bar} actions={<>{actions}<ShellMenuButton /></>} />
      <div className={cn(styles.body, styles.skin, bodyClassName)}>{children}</div>
    </SheetRoot>
  );
}

/**
 * The body grid: main column and a 340px rail with an action block under it. On a phone it is a column and the action
 * block sticks to the bottom of the screen. Render `DraftMain` and `DraftRail` as direct children. Use `as="form"` when
 * the whole layout is one form.
 */
export function DraftLayout({ as = "div", className, children, ...rest }: { as?: "div" | "form" } & ComponentPropsWithoutRef<"form">) {
  const Tag = as as "form";
  return <Tag {...rest} className={cn(styles.layout, className)}>{children}</Tag>;
}

export function DraftMain({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(styles.main, className)}>{children}</div>;
}

/**
 * The rail (340px, a left hairline) plus, under it, the action block: the one primary button of the page. Pass the button
 * as `actions`. On a phone the rail follows the main column and the actions stick to the bottom of the screen and the Report bug button lifts above them. Keep this a
 * direct child of `DraftLayout`.
 */
export function DraftRail({ children, className, actions, ...rest }: { children: ReactNode; className?: string; actions?: ReactNode } & ComponentPropsWithoutRef<"aside">) {
  return (
    <div className={styles.side}>
      <aside {...rest} className={cn(styles.rail, className)}>{children}</aside>
      {actions != null && actions !== false && <BugFabLift className={styles.actions}>{actions}</BugFabLift>}
    </div>
  );
}

/** A rail section: a sentence-case heading, then content, split from the next by a light line. */
export function RailSection({ title, children, className, id }: { title?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={cn(styles.railSec, className)} aria-labelledby={title && id ? id : undefined}>
      {title != null && <h2 className={styles.railH} id={id}>{title}</h2>}
      {children}
    </section>
  );
}

/** A quiet sentence under a rail control (the one-line consequence of a button). */
export function RailNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(styles.railNote, className)}>{children}</p>;
}

/** Label and value pairs in a rail. Values sit on the right; wrap numbers in `className="num"` through `num`. */
export function Rules({ rows, className }: { rows: Array<{ label: ReactNode; value: ReactNode; num?: boolean }>; className?: string }) {
  return (
    <dl className={cn(styles.rules, className)}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{row.label}</dt>
          <dd className={row.num ? styles.num : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A number in the number font, for use inside a sentence or a rail value. */
export function Num({ children }: { children: ReactNode }) {
  return <span className={styles.num}>{children}</span>;
}

/** Short separate pieces in a row with a gap and no separator (kind, players, time per pick). */
export function Pieces({ items, className, label }: { items: Array<{ key?: string; content: ReactNode; strong?: boolean }>; className?: string; label?: string }) {
  return (
    <ul className={cn(styles.pieces, className)} aria-label={label}>
      {items.map((item, i) => (
        <li key={item.key ?? i} className={item.strong ? styles.strong : undefined}>{item.content}</li>
      ))}
    </ul>
  );
}

/** A small round gem before a status word: hollow, filled in `--ink-2`, or dim. */
export function Gem({ fill = false, tone }: { fill?: boolean; tone?: "dim" }) {
  return <i className={styles.gem} data-fill={fill ? "true" : undefined} data-tone={tone} aria-hidden="true" />;
}
