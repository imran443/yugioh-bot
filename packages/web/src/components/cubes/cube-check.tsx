"use client";

import * as React from "react";
import { SectionHead, SizeBar, StatusLine } from "@/components/sheet";
import type { CubeDraftType } from "@/lib/cube-type";
import type { CubePoolsDto } from "@/lib/cube-pools";
import {
  boosterReadiness,
  cardsToRaise,
  cubeReadiness,
  poolTotals,
  THEME_CHOICES,
  THEME_EXTRA_CARDS,
  THEME_EXTRA_NEEDED,
  THEME_MAIN_CARDS,
  THEME_MAIN_NEEDED,
  type BoosterSettings,
  type PoolReadiness,
} from "./readiness";
import styles from "./cubes.module.css";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function Row({ label, bar, pool, short }: { label: string; bar: string; pool: PoolReadiness; short?: boolean }) {
  return (
    <div className={styles.rdRow}>
      <span>{label}</span>
      <SizeBar
        className={styles.rdSize}
        label={bar}
        value={pool.have}
        min={pool.need}
        max={Math.max(pool.need, pool.have)}
      />
      <span className={styles.rdVal} data-short={short ? "true" : undefined}>
        <b>{pool.have}</b> / {pool.need}
      </span>
    </div>
  );
}

function ThemeCheck({ pools }: { pools: CubePoolsDto }) {
  const main = poolTotals(pools.main);
  const readiness = cubeReadiness(main.usable, poolTotals(pools.extra).usable);
  const raise = cardsToRaise(pools.main, readiness.main.short);
  return (
    <section className={styles.check} aria-labelledby="ce-rd">
      <SectionHead
        id="ce-rd"
        title="Theme draft check"
        note={`${THEME_CHOICES} choices a pick, ${THEME_MAIN_CARDS} main and ${THEME_EXTRA_CARDS} extra`}
      />
      <Row
        label="Main"
        bar={`${readiness.main.have} of ${THEME_MAIN_NEEDED} main copies`}
        pool={readiness.main}
        short={readiness.main.short > 0}
      />
      <Row label="Extra" bar={`${readiness.extra.have} of ${THEME_EXTRA_NEEDED} Extra copies`} pool={readiness.extra} />
      {readiness.state === "blocked" ? (
        <StatusLine tone="warn">
          <b>
            {readiness.main.short} main {plural(readiness.main.short, "copy", "copies")} short.
          </b>{" "}
          A theme draft can&apos;t start with it.{" "}
          {raise != null
            ? `Raising ${raise} main ${plural(raise, "card", "cards")} to ×3 covers it.`
            : "Add more main cards to cover it."}
        </StatusLine>
      ) : readiness.state === "soft" ? (
        <StatusLine tone="neutral">
          <b>Extra may come up short.</b> {readiness.extra.have} of {THEME_EXTRA_NEEDED} Extra copies. A theme draft
          still starts.
        </StatusLine>
      ) : (
        <StatusLine tone="ready">
          <b>Ready for a theme draft.</b> Main and Extra both covered.
        </StatusLine>
      )}
    </section>
  );
}

function BoosterCheck({ pools, settings }: { pools: CubePoolsDto; settings: BoosterSettings }) {
  const r = boosterReadiness(poolTotals(pools.main).copies, poolTotals(pools.main).usable, settings);
  return (
    <section className={styles.check} aria-labelledby="ce-rd">
      <SectionHead
        id="ce-rd"
        title="Cube draft check"
        note={`${r.cardsPerPlayer} cards each, ${r.waves} ${plural(r.waves, "pack", "packs")} of ${r.packSize}`}
      />
      <Row
        label="Reach"
        bar={`${r.reach.have} of ${r.reach.need} cards one player can reach`}
        pool={r.reach}
        short={r.reach.short > 0}
      />
      <Row
        label="Pool"
        bar={`${r.copies2.have} of ${r.copies2.need} copies for 2 players`}
        pool={r.copies2}
        short={r.copies2.short > 0}
      />
      {r.cardsPerPlayer > r.waves * r.packSize ? (
        <StatusLine tone="warn">Packs hold {r.waves * r.packSize} cards per player; {r.cardsPerPlayer} are needed.</StatusLine>
      ) : r.copies2.short > 0 ? (
        <StatusLine tone="warn">
          <b>
            {r.copies2.short} more {plural(r.copies2.short, "copy", "copies")} needed.
          </b>{" "}
          Two players need {r.copies2.need} copies.
        </StatusLine>
      ) : r.reach.short > 0 ? (
        <StatusLine tone="warn">
          <b>
            One player can reach {r.reach.have} of {r.reach.need} cards.
          </b>{" "}
          A draft can start. A deck can use 3 copies of a card at most.
        </StatusLine>
      ) : (
        <StatusLine tone="ready">
          <b>Ready for a cube draft.</b> Seats up to {r.maxPlayers} {plural(r.maxPlayers, "player", "players")}.
        </StatusLine>
      )}
    </section>
  );
}

/** A plain cube is used for either draft: both checks as short lines, nothing alarming. */
function AnyCheck({ pools, settings, themeDraftsEnabled }: { pools: CubePoolsDto; settings: BoosterSettings; themeDraftsEnabled: boolean }) {
  const theme = cubeReadiness(poolTotals(pools.main).usable, poolTotals(pools.extra).usable);
  const booster = boosterReadiness(poolTotals(pools.main).copies, poolTotals(pools.main).usable, settings);
  return (
    <section className={styles.check} aria-labelledby="ce-rd">
      <SectionHead id="ce-rd" title="Cube check" note={themeDraftsEnabled ? "Works for theme drafts and cube drafts" : undefined} />
      {!themeDraftsEnabled ? null : theme.main.short > 0 ? (
        <StatusLine tone="neutral">
          <b>Theme draft:</b> needs {theme.main.short} more main {plural(theme.main.short, "copy", "copies")} (
          {theme.main.have} of {THEME_MAIN_NEEDED}).
        </StatusLine>
      ) : (
        <StatusLine tone="ready">
          <b>Theme draft:</b> ready.
          {theme.extra.short > 0 ? ` Extra may come up short (${theme.extra.have} of ${THEME_EXTRA_NEEDED}).` : ""}
        </StatusLine>
      )}
      {booster.cardsPerPlayer > booster.waves * booster.packSize ? (
        <StatusLine tone="warn"><b>Cube draft:</b> Packs hold {booster.waves * booster.packSize} cards per player; {booster.cardsPerPlayer} are needed.</StatusLine>
      ) : booster.copies2.short > 0 ? (
        <StatusLine tone="neutral">
          <b>Cube draft:</b> needs {booster.copies2.short} more {plural(booster.copies2.short, "copy", "copies")}{" "}
          ({booster.copies2.have} of {booster.copies2.need} for 2 players).
        </StatusLine>
      ) : booster.reach.short > 0 ? (
        <StatusLine tone="neutral">
          <b>Cube draft:</b> a player can reach {booster.reach.have} of {booster.reach.need} cards. Add more different
          cards.
        </StatusLine>
      ) : (
        <StatusLine tone="ready">
          <b>Cube draft:</b> ready for up to {booster.maxPlayers} {plural(booster.maxPlayers, "player", "players")}.
        </StatusLine>
      )}
    </section>
  );
}

/** The right-hand check panel. It follows the cube's type. */
export function CubeCheck({
  type,
  pools,
  settings = {},
  themeDraftsEnabled = false,
}: {
  type: CubeDraftType;
  pools: CubePoolsDto;
  settings?: BoosterSettings;
  /** The server says theme drafts are open. Closed, a plain cube is checked for cube drafts only. Default closed. */
  themeDraftsEnabled?: boolean;
}) {
  if (type !== "theme" && pools.main.length === 0 && settings.poolFromConfig) {
    return <section className={styles.check}><SectionHead title="Cube draft check" /><StatusLine tone="neutral">Pool from sets or passcodes; checked at draft start.</StatusLine></section>;
  }
  if (type === "theme") return <ThemeCheck pools={pools} />;
  if (type === "booster") return <BoosterCheck pools={pools} settings={settings} />;
  return <AnyCheck pools={pools} settings={settings} themeDraftsEnabled={themeDraftsEnabled} />;
}
