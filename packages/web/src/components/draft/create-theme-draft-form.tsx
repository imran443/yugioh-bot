"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { DraftConfig, DraftVisibility } from "@yugidraft/shared/types";
import { StatusLine, SvButton, SvCheck } from "@/components/sheet";
import { DraftLayout, DraftMain, DraftRail, Num, RailSection, Rules } from "./draft-frame";
import { secondsText, themeSelectionText } from "./create/format";
import { VisibilityChoice } from "./visibility/visibility-choice";
import { VISIBILITY_LABEL } from "@/lib/draft-invite";
import styles from "./create/create.module.css";
import tableStyles from "./theme/theme-table.module.css";

const SEATS_MIN = 2;
const SEATS_MAX = 8;
const SEATS_DEFAULT = 4;

type Channel = { id: string; name: string };

export interface CreateThemeDraftFormProps {
  /** The Discord bot is on. The server reads the flag; the form never reads the environment. When false there is no channel picker. Default off. */
  discordEnabled?: boolean;
  /** The server says theme drafts are open. Closed, the form says so and cannot be sent. The page also redirects. Default closed. */
  themeDraftsEnabled?: boolean;
}

export function CreateThemeDraftForm({ discordEnabled = false, themeDraftsEnabled = false }: CreateThemeDraftFormProps = {}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [channelId, setChannelId] = React.useState("");
  const [channels, setChannels] = React.useState<Channel[]>([]);
  // New drafts start private: only people with the host's invite link can see and join.
  const [visibility, setVisibility] = React.useState<DraftVisibility>("private");
  const [themePackSize, setThemePackSize] = React.useState(3);
  const [cardsPerPlayer, setCardsPerPlayer] = React.useState(40);
  const [extraDeckEnabled, setExtraDeckEnabled] = React.useState(true);
  const [extraDeckSize, setExtraDeckSize] = React.useState(15);
  const [copyLimit, setCopyLimit] = React.useState(true);
  const [burnUnpicked, setBurnUnpicked] = React.useState(false);
  const [uniqueThemes, setUniqueThemes] = React.useState(true);
  const [themeSelection, setThemeSelection] = React.useState<"player_pick" | "random">("player_pick");
  const [pickSeconds, setPickSeconds] = React.useState(45);
  const [lobbySeats, setLobbySeats] = React.useState(SEATS_DEFAULT);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!discordEnabled) return;
    fetch("/api/discord/channels")
      .then((res) => res.json())
      .then((data) => setChannels(data.channels ?? []))
      .catch(() => {});
  }, [discordEnabled]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!themeDraftsEnabled) return;
    if (!name.trim()) {
      setError("Draft name is required");
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    if (!Number.isInteger(lobbySeats) || lobbySeats < SEATS_MIN || lobbySeats > SEATS_MAX) {
      setError(`Seats must be a number from ${SEATS_MIN} to ${SEATS_MAX}`);
      return;
    }
    const config: DraftConfig = {
      mode: "theme",
      allowedCubeIds: [],
      themePackSize,
      cardsPerPlayer,
      extraDeckEnabled,
      extraDeckSize,
      burnUnpicked,
      copyLimit,
      uniqueThemes,
      themeSelection,
      pickSeconds,
      lobbySeats,
    };
    setSubmitting(true);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), channelId: discordEnabled ? channelId || undefined : undefined, visibility, config }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create theme draft");
      }
      const draft = await res.json();
      // Only after this explicit create: land at the Theme Table, where the themes are added and picked.
      router.push(draft.webSlug ? `/draft/${draft.webSlug}` : "/drafts");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  const unnamed = !name.trim();

  return (
    <DraftLayout as="form" onSubmit={handleSubmit}>
      <DraftMain>
        {!themeDraftsEnabled && (
          <div role="status" className={styles.alert}>
            <StatusLine tone="neutral">Theme drafts are not open yet.</StatusLine>
          </div>
        )}
        {error && (
          <div role="alert" className={styles.alert}>
            <StatusLine tone="block">{error}</StatusLine>
          </div>
        )}
        <div className={styles.sections}>
          <section className={styles.sec} aria-labelledby="dt-d">
            <div className={styles.secSide}>
              <h2 id="dt-d">Draft</h2>
              <p>{discordEnabled ? "Players see this name in Discord and on the web." : "Players see this name on the web."}</p>
            </div>
            <div className="fields">
              <div className="wide">
                <label className="label" htmlFor="theme-draft-name">
                  Draft name
                </label>
                <input
                  ref={nameRef}
                  className={`input${nameError ? " bad" : ""}`}
                  id="theme-draft-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (nameError) setNameError(false);
                  }}
                  placeholder="Theme night"
                  aria-invalid={nameError ? true : undefined}
                />
              </div>
              {discordEnabled && (
                <div className="wide">
                  <label className="label" htmlFor="theme-draft-channel">
                    Channel
                  </label>
                  <select
                    className="input select"
                    id="theme-draft-channel"
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value)}
                  >
                    <option value="">Default channel</option>
                    {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
                  </select>
                  <p className="hint">The bot posts the draft here so people can join from Discord.</p>
                </div>
              )}
              <div className="wide">
                <label className="label" htmlFor="theme-draft-seats">Seats at the table</label>
                <div className={tableStyles.stepper}>
                  <button type="button" aria-label="Fewer seats" disabled={lobbySeats <= SEATS_MIN} onClick={() => setLobbySeats((n) => Math.max(SEATS_MIN, n - 1))}>-</button>
                  <input
                    className="input"
                    id="theme-draft-seats"
                    type="number"
                    inputMode="numeric"
                    min={SEATS_MIN}
                    max={SEATS_MAX}
                    value={Number.isFinite(lobbySeats) ? lobbySeats : ""}
                    onChange={(e) => setLobbySeats(e.target.value === "" ? Number.NaN : Number(e.target.value))}
                  />
                  <button type="button" aria-label="More seats" disabled={lobbySeats >= SEATS_MAX} onClick={() => setLobbySeats((n) => Math.min(SEATS_MAX, n + 1))}>+</button>
                </div>
                <p className="hint">How many players you want. You can start with fewer. {SEATS_MIN} to {SEATS_MAX}.</p>
              </div>
              <VisibilityChoice className="wide" value={visibility} onChange={setVisibility} />
            </div>
          </section>

          <section className={styles.sec} aria-labelledby="dt-t">
            <div className={styles.secSide}>
              <h2 id="dt-t">Themes</h2>
              <p>Who drafts which archetype.</p>
            </div>
            <div className="fields">
              <fieldset className={`wide ${styles.fieldset}`}>
                <legend className="label">Theme selection</legend>
                <div className={styles.zoneOpts}>
                  <label className={styles.zoneOpt}>
                    <input
                      type="radio"
                      name="theme-selection"
                      value="player_pick"
                      checked={themeSelection === "player_pick"}
                      onChange={() => setThemeSelection("player_pick")}
                    />
                    <b>Players pick</b>
                    <span>Players claim a theme at the table. Anyone who hasn&apos;t claimed one gets one at the start.</span>
                  </label>
                  <label className={styles.zoneOpt}>
                    <input
                      type="radio"
                      name="theme-selection"
                      value="random"
                      checked={themeSelection === "random"}
                      onChange={() => setThemeSelection("random")}
                    />
                    <b>Random</b>
                    <span>Themes are dealt at random when you press Start.</span>
                  </label>
                </div>
              </fieldset>
              <label className={`wide ${styles.check}`}>
                <input type="checkbox" checked={uniqueThemes} onChange={(e) => setUniqueThemes(e.target.checked)} />
                <span>
                  <b>Every player gets a different theme</b>
                  You need at least one theme per player.
                </span>
              </label>
            </div>
          </section>

          <details className={tableStyles.advanced}>
          <summary>Advanced settings</summary>
          <section className={styles.sec} aria-labelledby="dt-p">
            <div className={styles.secSide}>
              <h2 id="dt-p">Picks</h2>
              <p>Each pick shows a few cards from your own theme. You take one.</p>
            </div>
            <div className={`fields ${styles.three}`}>
              <div>
                <label className="label" htmlFor="theme-main-size">Main deck size</label>
                <input className="input" id="theme-main-size" type="number" inputMode="numeric" min={40} max={120} value={cardsPerPlayer} onChange={(e) => setCardsPerPlayer(Number(e.target.value))} />
              </div>
              <div>
                <label className="label" htmlFor="theme-pack-size">Choices per pick</label>
                <input className="input" id="theme-pack-size" type="number" inputMode="numeric" min={2} value={themePackSize} onChange={(e) => setThemePackSize(Number(e.target.value))} />
              </div>
              <div>
                <label className="label" htmlFor="theme-pick-seconds">Pick duration</label>
                <span className={styles.unit}>
                  <input className="input" id="theme-pick-seconds" type="number" inputMode="numeric" min={5} value={pickSeconds} onChange={(e) => setPickSeconds(Number(e.target.value))} />
                  <span aria-hidden="true">seconds</span>
                </span>
              </div>
              <label className={`wide ${styles.check}`}>
                <input type="checkbox" checked={extraDeckEnabled} onChange={(e) => setExtraDeckEnabled(e.target.checked)} />
                <span>
                  <b>Draft an Extra deck</b>
                  After the main deck, everyone drafts up to this many Extra deck cards from their theme.
                </span>
              </label>
              <div>
                <label className="label" htmlFor="theme-extra-size">Extra deck size</label>
                <input className="input" id="theme-extra-size" type="number" inputMode="numeric" min={1} disabled={!extraDeckEnabled} value={extraDeckSize} onChange={(e) => setExtraDeckSize(Number(e.target.value))} />
              </div>
              <label className={`wide ${styles.check}`}>
                <input type="checkbox" checked={burnUnpicked} onChange={(e) => setBurnUnpicked(e.target.checked)} />
                <span>
                  <b>Burn unpicked choices</b>
                  Cards you pass on are gone for the rest of the draft. Off, they can come back in a later pick.
                </span>
              </label>
              <SvCheck
                className="wide"
                prominent
                label="Limit 3 copies per card"
                hint="Players can't take a 4th copy of any card."
                checked={copyLimit}
                onChange={(e) => setCopyLimit(e.target.checked)}
              />
            </div>
          </section>
          </details>
        </div>
      </DraftMain>

      <DraftRail
        aria-label="Draft summary"
        actions={
          <SvButton type="submit" variant="primary" big wide disabled={submitting || !themeDraftsEnabled} aria-busy={submitting || undefined}>
            Create theme draft
          </SvButton>
        }
      >
        <RailSection>
          <p className={styles.railKind}>Theme draft</p>
          <p className={`${styles.railName}${unnamed ? ` ${styles.unnamed}` : ""}`}>{unnamed ? "Untitled draft" : name.trim()}</p>
          <Rules
            rows={[
              { label: "Who can join", value: VISIBILITY_LABEL[visibility] },
              { label: "Seats", value: <><Num>{Number.isFinite(lobbySeats) ? lobbySeats : SEATS_DEFAULT}</Num> players</> },
              { label: "Themes", value: themeSelectionText(themeSelection, uniqueThemes) },
              { label: "Main deck", value: <><Num>{cardsPerPlayer}</Num> picks</> },
              { label: "Extra deck", value: extraDeckEnabled ? <>Up to <Num>{extraDeckSize}</Num> picks</> : "Not drafted" },
              { label: "Each pick", value: <><Num>{themePackSize}</Num> choices</> },
              { label: "Pick duration", value: secondsText(pickSeconds) },
              { label: "Passed cards", value: burnUnpicked ? "Gone for good" : "Can come back" },
            ]}
          />
        </RailSection>
        <RailSection title="What happens next">
          <ol className={styles.steps} aria-label="What happens next">
            <li><span>You get the Theme Table. Add one theme cube per archetype in its box.</span></li>
            {themeSelection === "random" ? (
              <>
                <li><span>Players join.</span></li>
                <li><span>You press Start. Everyone gets a random theme and drafts at once, main deck first.</span></li>
              </>
            ) : (
              <>
                <li><span>Players join and claim a theme.</span></li>
                <li><span>You press Start. Everyone drafts at once, main deck first.</span></li>
              </>
            )}
          </ol>
        </RailSection>
      </DraftRail>
    </DraftLayout>
  );
}
