"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DuelDeck, DuelDeckValidation, DuelMode, DuelSettings } from "@yugidraft/shared/duels";
import { AlertTriangle, CheckCircle2, FileUp, Info, Loader2, X } from "lucide-react";
import { cardArtUrl } from "./constants";
import { cx, SheetButton } from "./sheet-ui";
import ui from "./sheet-ui.module.css";
import styles from "./deck-editor.module.css";
import { applyDomainMaster, parseDeckText, selectDomainMaster, serializeYdk, type DeckMasterSelection } from "./ydk";
import { DeckValidationSkippedError, validateDuelDeck } from "./api";
import { DeckMasterPicker } from "./deck-master-picker";
import { canBeDeckMaster, isSpellOrTrapType, SPELL_TRAP_MASTER_MESSAGE, useDeckCardMeta, type DeckCardMeta } from "./deck-card-types";
import { SavedDeckPicker, useSavedDecks } from "./saved-deck-picker";
import { createSavedDeck, listSavedDecks } from "../decks/api";
import { deckNameFromFile } from "../decks/import";
import { modeLabel } from "../decks/model";
import { findSavedDuplicate, pastedDeckName, prepareImportSave, uniqueDeckName } from "./import-save";
import { CardAddField } from "./card-add-field";

/** A hung request must not block the saves after it. */
const SAVE_TIMEOUT_MS = 15_000;

type CardProblem = { name?: string; messages: string[] };

function Section({
  title,
  section,
  codes,
  onRemove,
  problems,
  target,
  onChooseMaster,
  cardMeta,
  onPreview,
}: {
  title: string;
  section: "main" | "extra" | "side";
  codes: number[];
  onRemove: (index: number) => void;
  problems: ReadonlyMap<string, CardProblem>;
  target?: string;
  onChooseMaster?: (code: number) => void;
  /** Card names and type bitmasks by passcode; the Master control shows only for monsters. */
  cardMeta?: ReadonlyMap<number, DeckCardMeta>;
  onPreview?: (code: number) => void;
}) {
  return (
    <section className={styles.list} aria-label={`${title} deck`}>
      <h3 className={styles.listHead}>
        <span className={styles.listTitle}>{title}</span>
        <span className={cx(ui.num, styles.count)}>{codes.length}</span>
        {target ? <span className={styles.target}>{target}</span> : null}
      </h3>
      {codes.length === 0 ? (
        <p className={styles.empty}>Empty</p>
      ) : (
        <ul className={styles.cards}>
          {codes.map((code, index) => {
            const problem = problems.get(`${section}:${index}`);
            const reason = problem?.messages.join(" ");
            const meta = cardMeta?.get(code);
            const cardName = meta?.name ?? problem?.name ?? code;
            return (
              <li key={`${title}-${index}-${code}`}>
                <button
                  type="button"
                  className={styles.card}
                  onClick={() => onRemove(index)}
                  onMouseEnter={() => onPreview?.(code)}
                  onFocus={() => onPreview?.(code)}
                  aria-label={`Remove ${cardName} from ${title}${reason ? `. Invalid: ${reason}` : ""}`}
                  title={reason ? `${reason} Click to remove this copy.` : "Click to remove this copy"}
                  data-invalid={problem ? "true" : undefined}
                >
                  <img src={cardArtUrl(code, "small")} alt="" loading="lazy" />
                  {problem ? (
                    <span className={styles.invalidTag}><AlertTriangle size={11} strokeWidth={1.8} aria-hidden />Invalid</span>
                  ) : null}
                  <span className={styles.removeVeil}><X size={16} strokeWidth={1.6} aria-hidden />Remove</span>
                </button>
                {onChooseMaster && meta && canBeDeckMaster(meta.type) ? (
                  <button type="button" className={styles.chooseMaster}
                    aria-label={`Use ${meta.name} as Deck Master`}
                    onClick={() => onChooseMaster(code)}>
                    Master
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function DeckEditor({
  slug,
  mode,
  settings,
  initial,
  busy,
  locked = false,
  onLocked,
  onReady,
  onPreviewCard,
}: {
  slug: string;
  mode: DuelMode;
  settings: DuelSettings;
  initial: DuelDeck | null;
  busy: boolean;
  /** The duel is starting or live: decks are locked, so no deck check runs. */
  locked?: boolean;
  /** The server answered a deck check with "locked": the room changed, so refresh it. */
  onLocked?: () => void;
  onReady: (deck: DuelDeck) => void;
  /** Called with the passcode of the deck card under the pointer or focus. */
  onPreviewCard?: (code: number) => void;
}) {
  const [selection, setSelection] = useState<DeckMasterSelection>(() => ({
    deck: initial ?? { main: [], extra: [], side: [] },
    masterOrigin: null,
  }));
  const { deck } = selection;
  const { main, extra, side, deckMaster: masterCode } = deck;
  const [paste, setPaste] = useState(initial ? serializeYdk(initial) : "");
  const [parseError, setParseError] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  // The deck as it came from the room or a saved deck. Replacing it asks for no confirmation.
  const [pristineDeck, setPristineDeck] = useState<DuelDeck>(deck);
  const [retry, setRetry] = useState(0);
  const cardMeta = useDeckCardMeta(deck, { enabled: mode === "domain", retry });
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const savedList = useSavedDecks();
  const importSeq = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [saveNote, setSaveNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [validation, setValidation] = useState<{
    slug: string;
    deck: DuelDeck;
    report?: DuelDeckValidation;
    error?: string;
    /** The room moved on while the check ran; nothing to show. */
    locked?: boolean;
  } | null>(null);
  const onLockedRef = useRef(onLocked);
  onLockedRef.current = onLocked;
  const sideAllowed = mode === "normal" || !settings.validateDeck;

  const currentValidation = validation?.slug === slug && validation.deck === deck ? validation : null;
  const report = currentValidation?.report;
  const showValidation = edited || initial !== null;
  const canReady = report !== undefined && report.issues.length === 0 && !parseError;
  const problems = useMemo(() => {
    const byPosition = new Map<string, CardProblem>();
    for (const issue of report?.issues ?? []) {
      for (const card of issue.cards) {
        const key = `${card.section}:${card.index}`;
        const existing = byPosition.get(key);
        if (existing) existing.messages.push(issue.message);
        else byPosition.set(key, { name: card.name, messages: [issue.message] });
      }
    }
    return byPosition;
  }, [report]);
  const masterProblem = problems.get("deckMaster:0");
  // The server check says the same once it answers; this shows it as soon as the card is known.
  const masterMessage = masterProblem?.messages.join(" ")
    ?? (mode === "domain" && masterCode != null && isSpellOrTrapType(cardMeta.get(masterCode)?.type) ? SPELL_TRAP_MASTER_MESSAGE : undefined);
  const leadCard = masterCode ?? main[0] ?? extra[0];

  useEffect(() => {
    if (leadCard != null) onPreviewCard?.(leadCard);
    // Only a new lead card resets the preview; hovering keeps control otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadCard]);

  useEffect(() => {
    if (locked) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void validateDuelDeck(slug, deck, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setValidation({ slug, deck, report: result });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof DeckValidationSkippedError) {
            setValidation({ slug, deck, locked: true });
            onLockedRef.current?.();
            return;
          }
          setValidation({ slug, deck, error: error instanceof Error ? error.message : "Could not validate this deck." });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug, deck, retry, locked]);

  function commitSelection(next: DeckMasterSelection) {
    setSelection(next);
    setPaste(serializeYdk(next.deck));
    setEdited(true);
    setParseError(null);
  }

  /** Saves an import to the player's decks, as given. A failed save never blocks the import itself. */
  async function saveImported(raw: DuelDeck, baseName: string, seq: number) {
    // Only the newest import shows a note; an older save that ends later stays silent.
    const note = (next: { text: string; error?: boolean }) => { if (seq === importSeq.current) setSaveNote(next); };
    try {
      if (raw.main.length + raw.extra.length + raw.side.length === 0 && raw.deckMaster === undefined) return;
      const prepared = prepareImportSave(raw, mode);
      if (!prepared.ok) {
        note({ text: "Not saved to your decks: saved Domain decks have no Side Deck." });
        return;
      }
      const existing = savedList.latest.current ?? await listSavedDecks(AbortSignal.timeout(SAVE_TIMEOUT_MS));
      const duplicate = findSavedDuplicate(existing, prepared.mode, prepared.deck);
      if (duplicate) {
        note({ text: `Already in your decks: ${duplicate.name}` });
        return;
      }
      const name = uniqueDeckName(baseName, existing.map((entry) => entry.name));
      const created = await createSavedDeck({ name, mode: prepared.mode, deck: prepared.deck }, AbortSignal.timeout(SAVE_TIMEOUT_MS));
      savedList.add(created);
      note({
        text: prepared.mode === mode
          ? `Saved to your decks as ${created.name}`
          : `Saved to your decks as ${created.name}, as a ${modeLabel(prepared.mode)} deck because it has a Deck Master.`,
      });
    } catch (error) {
      note({ text: `Could not save to your decks: ${error instanceof Error ? error.message : "try again later."}`, error: true });
    }
  }

  /** Saves run one after the other, so each one reads the list after the save before it. */
  function queueSave(raw: DuelDeck, baseName: string) {
    importSeq.current += 1;
    const seq = importSeq.current;
    saveQueue.current = saveQueue.current.then(() => saveImported(raw, baseName, seq)).catch(() => undefined);
  }

  function applyImported(raw: DuelDeck, baseName: string) {
    setSaveNote(null);
    queueSave(raw, baseName);
    const imported = mode === "domain"
      ? settings.validateDeck && raw.side.length <= 1 ? applyDomainMaster(raw) : raw
      : { main: raw.main, extra: raw.extra, side: raw.side };
    const extractedSideMaster = imported.deckMaster !== undefined && raw.deckMaster === undefined
      && raw.side.length === 1 && imported.side.length === 0;
    commitSelection({ deck: imported, masterOrigin: extractedSideMaster ? { section: "side", index: 0 } : null });
  }

  function chooseMaster(code?: number) {
    commitSelection(selectDomainMaster(selection, code));
  }

  function removeCard(section: "main" | "extra" | "side", index: number) {
    const origin = selection.masterOrigin;
    commitSelection({
      deck: { ...deck, [section]: deck[section].filter((_, i) => i !== index) },
      masterOrigin: origin?.section === section && index < origin.index
        ? { ...origin, index: origin.index - 1 }
        : origin,
    });
  }

  function onFile(file: File) {
    setFileName(file.name);
    file
      .text()
      .then((text) => applyImported(parseDeckText(text), deckNameFromFile(file.name)))
      .catch((error: unknown) => setParseError(error instanceof Error ? error.message : "Could not read that file."));
  }

  function onPasteApply() {
    try {
      const deck = parseDeckText(paste);
      if (deck.main.length === 0 && deck.extra.length === 0 && deck.side.length === 0 && deck.deckMaster === undefined) {
        setParseError("No cards found. Paste a YDK deck or a ydke:// link.");
        return;
      }
      applyImported(deck, pastedDeckName(new Date()));
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "Could not parse that deck.");
    }
  }

  function addCard(code: number, addSection: "main" | "extra" | "side") {
    const section = addSection === "side" && !sideAllowed ? "main" : addSection;
    commitSelection({ ...selection, deck: { ...deck, [section]: [...deck[section], code] } });
  }

  function submit() {
    if (!canReady || busy) return;
    onReady(deck);
  }

  const rulesNote = !settings.validateDeck
    ? `Custom deck: format and copy-limit checks are disabled. Card-pool and engine-safety restrictions still apply.${mode === "domain" ? " Choose a separate monster Deck Master." : ""}`
    : mode === "domain"
      ? "Domain: exactly 60 singleton Main Deck cards, up to 15 Extra Deck cards, and one separate Deck Master. The master determines your Domain; there is no separate leader or Domain selection."
      : "Normal: 40–60 Main Deck cards and up to 15 each in Extra and Side. To use a Deck Master, create a Domain table instead.";
  const mainTarget = !settings.validateDeck ? undefined : mode === "domain" ? "of 60" : "40–60";
  const extraTarget = settings.validateDeck ? "up to 15" : undefined;
  const sideTarget = settings.validateDeck && mode === "normal" ? "up to 15" : undefined;

  return (
    <div className={styles.editor}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <div className={styles.headTitle}>
            <h2 className={ui.sectionTitle}>Your deck</h2>
            <p className={styles.counts} aria-label="Deck counts">
              <span>Main <b className={ui.num}>{main.length}</b></span>
              <span>Extra <b className={ui.num}>{extra.length}</b></span>
              {sideAllowed || side.length > 0 ? <span>Side <b className={ui.num}>{side.length}</b></span> : null}
            </p>
          </div>
          <SheetButton kind="primary" size="lg" loading={busy} disabled={busy || locked || !canReady} onClick={submit}>
            Ready with this deck
          </SheetButton>
        </div>
        <p className={styles.rules}><Info size={15} strokeWidth={1.6} aria-hidden /><span>{rulesNote}</span></p>
      </header>

      <SavedDeckPicker mode={mode} disabled={busy} list={savedList} onLoad={(saved) => {
        const hasCards = main.length > 0 || extra.length > 0 || side.length > 0 || masterCode !== undefined;
        if (hasCards && deck !== pristineDeck
          && !window.confirm("Replace the deck you changed at this table? Your saved deck is unchanged.")) return false;
        const localDeck = mode === "normal"
          ? { main: saved.main, extra: saved.extra, side: saved.side }
          : saved;
        commitSelection({ deck: localDeck, masterOrigin: null });
        setPristineDeck(localDeck);
        setFileName(null);
        return true;
      }} />

      {showValidation && !locked && !currentValidation?.locked ? (
        <div aria-live="polite" role="status">
          {currentValidation?.error ? (
            <div className={cx(ui.banner, ui.bannerBad)}>
              <AlertTriangle size={17} strokeWidth={1.6} aria-hidden />
              <div className={ui.bannerBody}>
                <strong>Deck could not be checked</strong>
                <p>{currentValidation.error}</p>
                <div><SheetButton size="sm" onClick={() => {
                  setValidation(null);
                  setRetry((value) => value + 1);
                }}>Retry validation</SheetButton></div>
              </div>
            </div>
          ) : !report ? (
            <div className={ui.banner}>
              <Loader2 size={17} strokeWidth={1.6} className={ui.spin} aria-hidden />
              <p>Checking deck against this room&apos;s rules…</p>
            </div>
          ) : report.issues.length > 0 ? (
            <div className={cx(ui.banner, ui.bannerBad)}>
              <AlertTriangle size={17} strokeWidth={1.6} aria-hidden />
              <div className={ui.bannerBody}>
                <strong>Invalid deck — fix the following before readying</strong>
                <ul className={ui.bannerList}>
                  {report.issues.map((issue, index) => (
                    <li key={index}>
                      {issue.message}
                      {issue.cards.length > 1 ? <span className={styles.muted}> ({issue.cards.length} highlighted cards)</span> : null}
                    </li>
                  ))}
                </ul>
                {problems.size > 0 ? (
                  <p className={styles.muted}>Your imported cards are kept below. Click a red-outlined card to remove that copy.</p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className={cx(ui.banner, ui.bannerOk)}>
              <CheckCircle2 size={17} strokeWidth={1.6} aria-hidden />
              <p>Deck is valid for this room. You can ready up.</p>
            </div>
          )}
        </div>
      ) : null}


      <div className={styles.import}>
        <label className={styles.drop} data-dragging={dragging ? "true" : undefined}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) onFile(file);
          }}>
          <input
            type="file"
            accept=".ydk,text/plain"
            className={ui.srOnly}
            aria-label="YDK file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
            }}
          />
          <FileUp size={22} strokeWidth={1.4} aria-hidden />
          <span className={styles.dropTitle}>{fileName ?? "Drop a .ydk file"}</span>
          <span className={styles.dropHint}>{fileName ? "Choose another file to replace it" : "or click to choose one"}</span>
        </label>

        <div className={styles.paste}>
          <label>
            <span className={ui.label}>Paste YDK or YDKE</span>
            <textarea
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              rows={6}
              className={cx(ui.input, ui.textarea)}
              spellCheck={false}
              placeholder={"#main\n46986414\n#extra\n!side"}
            />
          </label>
          <SheetButton size="sm" onClick={onPasteApply}>Load paste</SheetButton>
        </div>
      </div>
      {saveNote ? (
        saveNote.error
          ? <p role="alert" className={ui.alert}>{saveNote.text}</p>
          : <p role="status" className={styles.muted}>{saveNote.text}</p>
      ) : null}

      {mode === "domain" ? (
        <DeckMasterPicker code={masterCode} onChange={chooseMaster}
          problem={masterMessage} custom={!settings.validateDeck} />
      ) : null}

      <CardAddField mode={mode} slug={slug} settings={settings} sideAllowed={sideAllowed} onAdd={addCard} onError={setParseError} />

      {parseError ? <p role="alert" className={ui.alert}>{parseError}</p> : null}

      <Section title="Main" section="main" codes={main} problems={problems} target={mainTarget}
        onRemove={(index) => removeCard("main", index)} onPreview={onPreviewCard} onChooseMaster={mode === "domain" ? chooseMaster : undefined} cardMeta={cardMeta} />
      <Section title="Extra" section="extra" codes={extra} problems={problems} target={extraTarget}
        onRemove={(index) => removeCard("extra", index)} onPreview={onPreviewCard} onChooseMaster={mode === "domain" ? chooseMaster : undefined} cardMeta={cardMeta} />
      {sideAllowed || side.length > 0 ? (
        <Section title="Side" section="side" codes={side} problems={problems} target={sideTarget}
          onRemove={(index) => removeCard("side", index)} onPreview={onPreviewCard} onChooseMaster={mode === "domain" ? chooseMaster : undefined} cardMeta={cardMeta} />
      ) : null}

    </div>
  );
}
