"use client";

import { useMemo, useState, type ReactNode } from "react";
import { seatsOfTeam, teamOfSeat, type DuelCard, type DuelCardInfo } from "@yugidraft/shared/duels";
import { zoneKey } from "../constants";
import { resolveEquipLinks } from "../equip-links";
import { DeckMasterRail } from "../field";
import { DuelHistoryRail } from "../history-rail";
import { CardInspector, cardScrollerProps } from "../inspector";
import { livePileCards } from "../pile-focus";
import { PileViewer } from "../pile-viewer";
import { optionsForCard, PromptTray } from "../prompts";
import type { DuelPreferences } from "../preferences";
import roomStyles from "../room.module.css";
import { CardTabEmpty, DESKTOP_PANES, desktopPane, SidePanel, SideTabs, useIsNarrow } from "../side-panel";
import { MatchSheetLog } from "../text-log";
import { HistoryStrip } from "../table/history-strip";
import { HudLayer, type HudPaneState } from "../table/hud-layer";
import { hudPreview } from "../table/hud-preview";
import { hudMasterProps } from "../table/hud-shared";
import { tableLayout } from "../table/geometry";
import { TablePhonePanes } from "../table/table-phone-panes";
import { TableSettings } from "../table/table-settings";
import { toneBySeat } from "../table/seat-state";
import { SEAT_TONE_HEX, type InspectTarget, type TableController } from "../table/types";
import type { TableUi } from "../table/use-table-ui";
import type { TableShellProps } from "../table/table-shell";
import { pileSideForSeat } from "./live-tag";
import { firstInspectCard } from "./tag-logic";
import styles from "./tag-side.module.css";

/** The slice of `useTableUi` that the side panels read and write. The room passes the whole `TableUi`. */
export type TagSideUi = Pick<TableUi, "pane" | "setPane" | "inspect" | "setInspect" | "inspectCard" | "pile" | "closePile">;

const tagTeamOf = (seat: number) => teamOfSeat("tag", seat);

/** Seat tones of the Rooftop (the layout's tone per seat), shared by the strip, the log and the pile viewer. */
function useSeatTones(controller: TableController) {
  const { engine, viewerSeat } = controller;
  const layout = useMemo(
    () => tableLayout("tag", engine, viewerSeat),
    // The layout depends on who sits where, never on a card: the seat list is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine.seats.length, viewerSeat],
  );
  return useMemo(() => {
    const tones = toneBySeat(layout);
    return new Map([...tones].map(([seat, tone]) => [seat, SEAT_TONE_HEX[tone]] as const));
  }, [layout]);
}

/**
 * The floating HUD of the wide Rooftop (`table/hud-layer.tsx`). With it, `TagSide` renders no columns: the HUD layer
 * (dock, flyouts, Deck Master plates, hover preview) and the prompt tray as a floating card. `camera` is the camera dock,
 * a fourth dock icon.
 */
export type TagSideHud = {
  state: HudPaneState;
  /** The hovered card, for the preview. */
  hover: TableUi["hover"];
  /** The card of a prompt row under the pointer: the preview shows it when no board card is hovered. */
  rowCard: DuelCardInfo | null;
  /** The tray draws something a player sees. When it does not, the floating card hides. */
  trayVisible: boolean;
  /** The card of the open card menu: the preview keeps showing it while the menu is open and no other card is hovered. */
  menuCard: DuelCard | null;
  camera: ReactNode;
};

export type TagSideProps = Pick<TableShellProps, "connection" | "settingsTools"> & {
  /** The controller the board uses (menu and aim aware), so the tray, the master docks and the pile act like the board. */
  controller: TableController;
  ui: TagSideUi;
  /** The shell's one `useDuelPreferences()` object, so the header sound toggle and the Settings tab agree. */
  preferences: DuelPreferences;
  /** The phone sheet. Pass both to let the shell suspend its keys while the sheet is open; else it is local. */
  sheetOpen?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
  /** The prompt tray (chain response, action prompts) at the foot of the left column. Default: a `PromptTray`. */
  tray?: ReactNode;
  /** Classes the shell uses to place the left column and the Deck Master column in its grid. */
  leftClassName?: string;
  mastersClassName?: string;
  /** The floating HUD (wide screens only). Leave out for the columns and the phone panes. */
  hud?: TagSideHud;
  /** Replay mode: the Settings tab leaves out the replay link of the duel it is showing. */
  replay?: boolean;
};

/**
 * The side panels of the Rooftop: the history strip and the Card / Log / Settings tabs in the left column, the Deck
 * Master column (Domain only) and, on a narrow screen, the phone bar and sheet. It renders a fragment: the left
 * `<aside>`, then (wide Domain only) the masters `<aside>`, then (narrow only) the phone panes. Mount the pile viewer
 * with `TagPileViewer` in the board overlay.
 */
export function TagSide({
  controller,
  ui,
  connection,
  settingsTools,
  preferences,
  sheetOpen: sheetOpenProp,
  onSheetOpenChange,
  tray,
  leftClassName,
  mastersClassName,
  hud,
  replay = false,
}: TagSideProps) {
  const { engine, room, viewerSeat, nameOf, prompt } = controller;
  const session = room.session;
  const domain = session.mode === "domain";
  const narrow = useIsNarrow();
  const [localOpen, setLocalOpen] = useState(false);
  const sheetOpen = sheetOpenProp ?? localOpen;
  const setSheetOpen = (open: boolean) => {
    setLocalOpen(open);
    onSheetOpenChange?.(open);
  };
  const [logUnread, setLogUnread] = useState(0);
  const seatTones = useSeatTones(controller);
  const canAct = controller.canAct && !controller.busy;
  const logVisible = hud ? hud.state.pane === "log" : ui.pane === "log" && (!narrow || sheetOpen);
  const selectedPane = desktopPane(ui.pane);

  const openCard = (card: DuelCard | DuelCardInfo) =>
    ui.inspectCard("location" in card ? { type: "card", card } : { type: "info", card });
  // Before anything is hovered the Card tab shows the viewer's first face-up monster (else a hand card).
  const startCard = ui.inspect ? null : firstInspectCard(engine, viewerSeat);
  const startTarget: InspectTarget | null = ui.inspect ?? (startCard ? { type: "card", card: startCard } : null);

  const cardPanel = startTarget ? (
    <CardInspector
      target={startTarget}
      onInspectCard={(card) => ui.setInspect({ type: "card", card })}
      onActivateCard={(card, anchor) => controller.onActivate([zoneKey(card.controller, card.location, card.sequence)], card, anchor, true)}
      equipLinks={resolveEquipLinks(engine.seats)}
      ownerOf={(card) => ({ name: nameOf(card.controller), tone: seatTones.get(card.controller) ?? SEAT_TONE_HEX.ice })}
    />
  ) : (
    <CardTabEmpty />
  );
  const logPanel = (
    <div className={roomStyles.logPane}>
      <DuelHistoryRail
        key={session.slug}
        events={engine.events}
        engine={engine}
        mySeat={viewerSeat}
        playerName={nameOf}
        onInspectCard={openCard}
        reducedMotion={controller.reducedMotion}
        active={logVisible}
        onUnread={setLogUnread}
        seatTones={seatTones}
      />
      <details className={roomStyles.textLog}>
        <summary>Text log</summary>
        <MatchSheetLog entries={engine.log} playerName={nameOf} players={session.seats.map((seat) => seat.displayName).join(" v ")} seatTones={seatTones} />
      </details>
    </div>
  );
  const settingsPanel = <TableSettings controller={controller} preferences={preferences} connection={connection} tools={settingsTools} replay={replay} />;

  // Deck Masters: your own, with your partner's above it (read-only). A spectator sees the anchor seat's master.
  const partner = viewerSeat == null ? undefined : seatsOfTeam("tag", tagTeamOf(viewerSeat)).find((seat) => seat !== viewerSeat);
  const masterRail = domain ? (
    <DeckMasterRail
      engine={engine}
      mySeat={viewerSeat}
      legalKeys={controller.legalKeys}
      selectedKeys={controller.selectedKeys}
      canAct={canAct}
      legalActionsFor={(card, keys) => (canAct && prompt?.kind === "choice" && prompt.context?.type === "action" ? optionsForCard(prompt, card, keys) : [])}
      onChooseAction={(option) => controller.onAnswer({ choice: option.id })}
      onActivate={controller.onActivate}
      onHoverCard={controller.onHoverCard}
      onInspect={controller.onInspect}
      rivals={partner == null ? [] : [{ seat: partner, title: `${nameOf(partner)}'s Master` }]}
      selfTitle={viewerSeat == null ? `${nameOf(0)}'s Master` : undefined}
    />
  ) : null;

  const trayNode = tray ?? (
    <PromptTray
      prompt={prompt}
      mySeat={viewerSeat}
      slug={session.slug}
      busy={controller.busy}
      draft={controller.draft}
      onSubmit={controller.onAnswer}
      active={session.status === "active"}
      waitingName={prompt ? nameOf(prompt.seat) : null}
    />
  );

  if (hud && !narrow) {
    // A spectator sees the anchor seat (seat 0), as the Deck Master column did.
    const seat = viewerSeat ?? 0;
    const source = {
      legalKeys: controller.legalKeys,
      selectedKeys: controller.selectedKeys,
      canAct,
      prompt,
      onAnswer: controller.onAnswer,
      onActivate: controller.onActivate,
      onHoverCard: controller.onHoverCard,
    };
    return (
      <>
        <div className={styles.hudTray} data-tone={prompt?.context?.type === "chain" ? "chain" : "action"} data-empty={hud.trayVisible ? undefined : "true"} data-prompt-surface={prompt ? "" : undefined}>{trayNode}</div>
        <HudLayer
          hud={hud.state}
          panels={{ card: cardPanel, log: logPanel, settings: settingsPanel, camera: hud.camera }}
          chain={engine.chain}
          chainOpen={engine.chain.length > 0 && session.status === "active"}
          nameOf={nameOf}
          seatTones={seatTones}
          logUnread={logUnread}
          master={domain ? hudMasterProps(source, engine.seats.find((view) => view.seat === seat), viewerSeat != null, viewerSeat == null ? `${nameOf(seat)}'s Master` : "Your Master") : null}
          otherMaster={domain && partner != null ? hudMasterProps(source, engine.seats.find((view) => view.seat === partner), false, `${nameOf(partner)}'s Master`) : null}
          onInspect={ui.setInspect}
          preview={hudPreview(hud.hover?.card ?? null, hud.menuCard, hud.rowCard, (card) => ({ name: nameOf(card.controller), ...(seatTones.get(card.controller) ?? SEAT_TONE_HEX.ice) }), hud.state.pinned)}
          equipLinks={resolveEquipLinks(engine.seats)}
          previewHidden={ui.pile?.open === true}
          reducedMotion={controller.reducedMotion}
        />
      </>
    );
  }

  return (
    <>
      {narrow ? null : (
        <aside className={`${styles.left} ${leftClassName ?? ""}`} aria-label="Duel panels" data-tag-side="left">
          <HistoryStrip
            engine={engine}
            mySeat={viewerSeat}
            playerName={nameOf}
            seatTones={seatTones}
            onInspectCard={openCard}
            onOpenLog={() => ui.setPane("log")}
          />
          <SideTabs panes={DESKTOP_PANES} selected={selectedPane} unread={logUnread} onSelect={ui.setPane} />
          <div className={styles.sideContent} {...cardScrollerProps(selectedPane === "card")}>
            <SidePanel pane="card" selected={selectedPane}>{cardPanel}</SidePanel>
            <SidePanel pane="log" selected={selectedPane} keepMounted>{logPanel}</SidePanel>
            <SidePanel pane="settings" selected={selectedPane}>{settingsPanel}</SidePanel>
          </div>
          <div className={styles.tray} data-tone={prompt?.context?.type === "chain" ? "chain" : "action"}>{trayNode}</div>
        </aside>
      )}
      {masterRail && !narrow ? (
        <aside className={`${styles.masters} ${mastersClassName ?? ""}`} aria-label="Deck Masters" data-tag-side="masters">
          {masterRail}
        </aside>
      ) : null}
      {narrow ? (
        <TablePhonePanes
          domain={domain}
          pane={ui.pane}
          open={sheetOpen}
          unread={logUnread}
          onClose={() => setSheetOpen(false)}
          onSelect={(pane) => {
            ui.setPane(pane);
            setSheetOpen(true);
          }}
          card={cardPanel}
          log={logPanel}
          settings={settingsPanel}
          masters={masterRail}
        />
      ) : null}
    </>
  );
}

/**
 * The pile viewer of the Rooftop, for the board overlay. A pile of your partner reads as your side ("you"); a rival's
 * pile reads as the opposing side. Renders nothing while no pile was opened.
 */
export function TagPileViewer({ controller, ui }: { controller: TableController; ui: TagSideUi }) {
  const { engine, viewerSeat, nameOf } = controller;
  const seatTones = useSeatTones(controller);
  const pile = ui.pile;
  if (!pile) return null;
  const ownerSeat = pile.seat ?? pile.cards[0]?.controller ?? null;
  const owner = ownerSeat == null ? pile.owner : pileSideForSeat(viewerSeat, ownerSeat, tagTeamOf) === "you" ? "you" : "opp";
  const tone = ownerSeat == null ? undefined : seatTones.get(ownerSeat);
  return (
    <PileViewer
      title={pile.title}
      owner={owner}
      ownerTag={ownerSeat != null && tone ? { name: nameOf(ownerSeat), tone } : null}
      open={pile.open}
      cards={livePileCards(pile, engine, viewerSeat)}
      onClose={ui.closePile}
      onInspectCard={(card) => ui.inspectCard({ type: "card", card })}
      onHoverCard={(card) => { if (ui.pane === "card") ui.setInspect({ type: "card", card }); }}
      onActivateCard={(card, anchor) => controller.onActivate([zoneKey(card.controller, card.location, card.sequence)], card, anchor, true)}
      legalKeys={controller.legalKeys}
      selectedKeys={controller.selectedKeys}
      reducedMotion={controller.reducedMotion}
    />
  );
}
