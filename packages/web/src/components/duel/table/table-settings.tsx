"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BugReportMenuButton } from "../../bug-report/bug-report-menu-button";
import type { DuelWebsocketState } from "@/lib/hooks/use-duel-websocket";
import fxStyles from "../battle-fx.module.css";
import { DuelAnimationSpeedControl } from "../animation-speed-control";
import { DuelCardTextSizeControl } from "../card-text-size-control";
import { DuelDiceSkinControl } from "../dice-skin-control";
import { duelFontClasses } from "../fonts";
import { DUEL_SHAKE_LABEL, DUEL_SHAKE_LEVELS, type DuelPreferences } from "../preferences";
import { DuelSettingsSummary, DuelSoundControls, RoomInvite } from "../room-settings";
import roomStyles from "../room.module.css";
import type { TableController } from "./types";

/** The Settings tab of the left column of a table. The match sheet log is shared with the room (../text-log). */

export type TableConnection = Pick<DuelWebsocketState, "connected" | "syncing" | "recovering" | "presence" | "resync"> & {
  stale?: boolean;
  error?: boolean;
  /** HTTP action in flight, distinct from the connection gate that blocks duel answers. */
  actionBusy?: boolean;
};

export function TableSettings({ controller, preferences, connection, tools, replay = false }: {
  controller: TableController;
  preferences: DuelPreferences;
  connection?: TableConnection;
  tools?: ReactNode;
  /** The table is a replay: no link back to the replay of this very duel, and no live-duel text. */
  replay?: boolean;
}) {
  const { room } = controller;
  const terminal = room.session.status !== "active";
  const [resyncError, setResyncError] = useState<string | null>(null);
  return (
    <div className={roomStyles.options}>
      <DuelSettingsSummary session={room.session} />
      {connection ? <RoomInvite room={room} slug={room.session.slug} /> : null}
      <h2>Presentation</h2>
      <DuelAnimationSpeedControl />
      <DuelCardTextSizeControl />
      <DuelDiceSkinControl />
      <DuelSoundControls
        enabled={preferences.soundEnabled}
        volume={preferences.soundVolume}
        onEnabledChange={preferences.setSoundEnabled}
        onVolumeChange={preferences.setSoundVolume}
      />
      <label className="flex flex-col gap-2">Motion
        <select value={preferences.motion} onChange={(event) => preferences.setMotion(event.target.value as typeof preferences.motion)}>
          <option value="system">Use device setting</option>
          <option value="reduced">Reduced motion</option>
          <option value="full">Full motion</option>
        </select>
      </label>
      <div className={`${fxStyles.shakeRow} ${duelFontClasses}`}>
        <span>Screen shake</span>
        <div className={fxStyles.segment} role="group" aria-label="Screen shake">
          {DUEL_SHAKE_LEVELS.map((level) => (
            <button key={level} type="button" aria-pressed={preferences.shake === level} onClick={() => preferences.setShake(level)}>
              {DUEL_SHAKE_LABEL[level]}
            </button>
          ))}
        </div>
        <p className={fxStyles.shakeNote}>How hard heavy summons rattle the field.</p>
      </div>
      {controller.prompt?.context?.type === "action" ? controller.prompt.options.filter((option) => option.id === "shuffle").map((option) => (
        <Button key={option.id} type="button" size="sm" variant="secondary" disabled={!controller.canAct || controller.busy}
          onClick={() => controller.onAnswer({ choice: option.id })}>{option.label}</Button>
      )) : null}
      <p>Effects never pause the duel or submit a response. Camera keys: Tab, P, H, O, F, S, A, K.</p>
      {connection ? (
        <>
          <h2>Connection</h2>
          <p role="status">{terminal ? "Showing the saved final state." : connection.syncing || connection.stale
            ? "Catching up to the current duel. Actions resume when the latest state arrives."
            : connection.connected && !connection.recovering && !connection.error ? "Live updates connected."
              : "Reconnecting live updates; polling for the latest state."}</p>
          {!terminal ? <Button type="button" size="sm" variant="secondary" disabled={(connection.actionBusy ?? controller.busy) || connection.syncing}
            onClick={() => {
              setResyncError(null);
              void connection.resync().catch(() => setResyncError("Could not catch up. Check your connection and retry."));
            }}>Catch up now</Button> : null}
          {resyncError ? <p role="alert">{resyncError}</p> : null}
          {controller.viewerSeat == null ? <p>Watching only. All players’ hidden cards remain private.</p> : null}
          {connection.presence ? <div>
            <p>{connection.presence.spectatorCount} watching</p>
            {room.session.seats.map((seat) => <p key={seat.seat}>{seat.displayName} · {seat.isBot ? "Bot"
              : connection.presence?.onlineSeats.includes(seat.seat) ? "Connected" : "Disconnected"}</p>)}
          </div> : null}
        </>
      ) : null}
      {connection ? <BugReportMenuButton room={room} /> : null}
      {tools}
      {!replay && (room.session.status === "completed" || room.session.status === "interrupted") ? <>
        <p>Finished. This duel is in Match history.</p>
        <Link href={`/duels/${room.session.slug}/replay`}>Watch replay</Link>
      </> : null}
      <Link href="/duels">Back to tables</Link>
    </div>
  );
}
