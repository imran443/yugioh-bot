import type { DuelChainLink, DuelBattleStep, DuelCard, DuelFormat, DuelCardInfo, DuelEngineView, DuelEvent, DuelMode, DuelMoveReason, DuelPrompt, DuelPromptOption, DuelSeatView, DuelSummonKind, DuelZoneRef } from "@yugidraft/shared/duels";
import {
  OcgHintType,
  OcgLocation,
  OcgMessageType,
  OcgPhase,
  OcgPosition,
  OcgQueryFlags,
  OcgType,
  ocgPhaseString,
  type OcgCardQueryInfo,
  type OcgCoreSync,
  type OcgDuelHandle,
  type OcgLocation as OcgLocationValue,
  type OcgMessage,
  type OcgQueryFlags as OcgQueryFlagsValue,
} from "ocgcore-wasm";
import { partnerSeatOf, seatCountFor, sharedExtraSeatOf, teamOfSeat } from "@yugidraft/shared/duels";
import { raceLabel, type CardDatabase } from "./cards.js";
import { fillPlaceholders, locationLabel } from "./text.js";
import type { CoreCapabilities } from "./core-capabilities.js";
import { HandIdentities } from "./hand-identities.js";
import { chainTargetPhrase, parseTargetCardNote, publicTargetLabel, TARGET_CARD_NOTE_LUA, TARGET_CARD_NOTE_PREFIX, type TargetCardNote, type TargetLabel } from "./target-names.js";

export const LOCATION_DECKMASTER = 0x4000;
export const DOMAIN_LEAVE_TAX_STEP = 500;
export const DOMAIN_RECALL_DESC = 0x444D5243;

export interface DomainSeatState {
  inZone: boolean;
  code: number;
  returns: number;
  nextCost: number;
}

export interface LogEntry {
  id: number;
  text: string;
  audience: "all" | number;
  eventId?: number;
}

export type RevealMap = Map<number, Map<string, number>>;

/**
 * With more than two duelists the core writes 0xFF in a controller field that has no duelist (a card between
 * locations, a card never placed). With two duelists nothing changes: no value is read as "no duelist".
 */
export const DUELIST_NONE = 0xff;

export function isNoDuelist(format: DuelFormat | undefined, controller: number): boolean {
  return controller === DUELIST_NONE && seatCountFor(format ?? "1v1") > 2;
}

/** The controller as a seat, or undefined when it is "no duelist". */
function seatOf(format: DuelFormat | undefined, controller: number): number | undefined {
  return isNoDuelist(format, controller) ? undefined : controller;
}

/** "Player N" for a seat, "No duelist" for the no-duelist value. */
export function playerLabel(format: DuelFormat | undefined, controller: number): string {
  return isNoDuelist(format, controller) ? "No duelist" : `Player ${controller + 1}`;
}

/** Who may see a card of this controller: nobody when there is no duelist. */
function audienceOf(format: DuelFormat | undefined, controller: number): number | readonly number[] {
  return isNoDuelist(format, controller) ? [] : controller;
}

/** A board place as a zone reference, or undefined when its controller is "no duelist". */
function zoneRefOf(format: DuelFormat | undefined, place: { controller: number; location: number; sequence: number }): DuelZoneRef | undefined {
  return isNoDuelist(format, place.controller) ? undefined : { controller: place.controller, location: place.location, sequence: place.sequence };
}

export function slotKey(controller: number, location: number, sequence: number): string {
  return `${controller}:${location}:${sequence}`;
}

export function createRevealMap(seatCount = 2): RevealMap {
  return new Map(Array.from({ length: seatCount }, (_, seat) => [seat, new Map<string, number>()] as [number, Map<string, number>]));
}

export function noteReveal(reveals: RevealMap, viewer: number, controller: number, location: number, sequence: number, code: number): void {
  reveals.get(viewer)?.set(slotKey(controller, location, sequence), code);
}

export function slotRevealed(reveals: RevealMap, viewer: number | null, controller: number, location: number, sequence: number, code?: number): boolean {
  if (viewer == null) return false;
  const stored = reveals.get(viewer)?.get(slotKey(controller, location, sequence));
  if (stored == null) return false;
  return code == null || code === 0 || stored === code;
}

export function moveReveals(
  reveals: RevealMap,
  from: { controller: number; location: number; sequence: number },
  to: { controller: number; location: number; sequence: number; position?: number },
  code: number,
): void {
  const origin = slotKey(from.controller, from.location, from.sequence);
  const fromField = from.location === OcgLocation.MZONE || from.location === OcgLocation.SZONE;
  // A card that was revealed in the hand (or elsewhere off the field) and is then Set face-down is hidden again.
  // Location 0 is a card that left the game (REMOVE_CARDS).
  const forget =
    to.location === 0 ||
    to.location === OcgLocation.DECK ||
    (to.location === OcgLocation.EXTRA && isFacedownPosition(to.position)) ||
    ((to.location === OcgLocation.MZONE || to.location === OcgLocation.SZONE) && !fromField && isFacedownPosition(to.position));
  for (const tracked of reveals.values()) {
    const stored = tracked.get(origin);
    tracked.delete(origin);
    const shiftHand = (controller: number, sequence: number, delta: number) => {
      const prefix = `${controller}:${OcgLocation.HAND}:`;
      const changed = [...tracked].filter(([key]) => key.startsWith(prefix) && Number(key.slice(prefix.length)) >= sequence);
      for (const [key] of changed) tracked.delete(key);
      for (const [key, value] of changed) tracked.set(`${prefix}${Number(key.slice(prefix.length)) + delta}`, value);
    };
    if (from.location === OcgLocation.HAND) shiftHand(from.controller, from.sequence + 1, -1);
    if (to.location === OcgLocation.HAND) shiftHand(to.controller, to.sequence, 1);
    if (stored == null || forget || (code !== 0 && stored !== code)) continue;
    tracked.set(slotKey(to.controller, to.location, to.sequence), stored);
  }
}

export function clearRevealsAt(reveals: RevealMap, controller: number, location: number): void {
  const prefix = `${controller}:${location}:`;
  for (const tracked of reveals.values()) {
    for (const key of [...tracked.keys()]) {
      if (key.startsWith(prefix)) tracked.delete(key);
    }
  }
}

const QUERY_FLAGS = (
  OcgQueryFlags.CODE |
  OcgQueryFlags.POSITION |
  OcgQueryFlags.LEVEL |
  OcgQueryFlags.RANK |
  OcgQueryFlags.ATTRIBUTE |
  OcgQueryFlags.RACE |
  OcgQueryFlags.ATTACK |
  OcgQueryFlags.DEFENSE |
  OcgQueryFlags.OVERLAY_CARD |
  OcgQueryFlags.EQUIP_CARD |
  OcgQueryFlags.COUNTERS |
  OcgQueryFlags.OWNER |
  OcgQueryFlags.STATUS |
  OcgQueryFlags.IS_PUBLIC |
  OcgQueryFlags.LSCALE |
  OcgQueryFlags.RSCALE |
  OcgQueryFlags.LINK |
  OcgQueryFlags.IS_HIDDEN
) as OcgQueryFlagsValue;

/** ygopro-core STATUS_DISABLED: the card's effects are negated (by an effect, a Chain Link or a continuous field effect). */
const STATUS_DISABLED = 0x0001;

/**
 * True for a face-up monster or Spell/Trap on the field whose effects are negated right now. Face-down cards,
 * and cards off the field, never report it, so the flag leaks nothing about a Set card.
 */
export function isNegatedOnField(location: number, position: number, status: number | undefined): boolean {
  if (status == null || (status & STATUS_DISABLED) === 0) return false;
  if (location !== OcgLocation.MZONE && location !== OcgLocation.SZONE) return false;
  return (position & OcgPosition.FACEUP) !== 0;
}

export function isFacedownPosition(position: number | undefined): boolean {
  return position != null && (position & OcgPosition.FACEDOWN) !== 0;
}

export function cardIsVisible(args: {
  viewer: number | null;
  controller: number;
  location: number;
  position: number;
  isPublic?: boolean;
  isHidden?: boolean;
  revealed?: boolean;
  /** The viewer's Tag partner is the controller: partners see each other's hand and Set cards (ADR-0002). */
  partner?: boolean;
}): boolean {
  if (args.revealed) return true;
  if (args.isPublic) return true;
  const own = args.viewer !== null && args.viewer === args.controller;
  const friend = own || args.partner === true;
  if (args.location === OcgLocation.DECK) return false;
  if (args.location === OcgLocation.HAND) return friend;
  if (args.location === OcgLocation.GRAVE) return true;
  if (args.location === OcgLocation.EXTRA) return own || (!args.isHidden && !isFacedownPosition(args.position));
  if (args.location === OcgLocation.REMOVED) return own || !isFacedownPosition(args.position);
  if (args.location === OcgLocation.MZONE || args.location === OcgLocation.SZONE || args.location === LOCATION_DECKMASTER) {
    return friend || !isFacedownPosition(args.position);
  }
  return own;
}

export function redactCard(card: DuelCard, visible: boolean): DuelCard {
  if (visible) return card;
  return {
    controller: card.controller,
    location: card.location,
    sequence: card.sequence,
    position: card.position,
  };
}

function queryToCard(
  controller: number,
  location: number,
  sequence: number,
  query: Partial<OcgCardQueryInfo> | null | undefined,
  cards: CardDatabase,
  materials: DuelCard[] | undefined,
): DuelCard | null {
  if (!query) return null;
  const position = query.position ?? 0;
  if (!query.code && !position) return null;
  const info = query.code ? cards.get(query.code) : undefined;
  const counters = query.counters
    ? Object.entries(query.counters).map(([type, count]) => ({ type: Number(type), count }))
    : undefined;
  // A monster whose Level an effect lowered to 0 keeps that 0; Spells and Traps have no Level.
  const level = query.level || query.rank || query.link?.rating ||
    (query.level === 0 && ((info?.type ?? 0) & OcgType.MONSTER) !== 0 ? 0 : undefined);
  const card: DuelCard = {
    controller,
    location,
    sequence,
    position,
    code: query.code,
    canonicalPasscode: info?.canonicalPasscode,
    name: info?.name,
    description: info?.description,
    attack: query.attack,
    defense: query.defense,
    level,
    type: info?.type,
    attribute: query.attribute ?? info?.attribute,
    race: query.race != null ? raceLabel(query.race) : info?.race,
    counters: counters && counters.length > 0 ? counters : undefined,
    materials,
  };
  if (isNegatedOnField(location, position, query.status)) card.negated = true;
  if (query.rank) card.rank = query.rank;
  if (query.link) {
    card.linkRating = query.link.rating;
    card.linkMarker = query.link.marker as number;
  }
  // The core reports, on the equip card, the monster it is attached to (an Equip Spell, a Union
  // monster, or any card an effect equips). Live state, so it follows the monster across zones.
  if (query.equipCard) {
    card.equippedTo = { controller: query.equipCard.controller, location: query.equipCard.location, sequence: query.equipCard.sequence };
  }
  return card;
}

function queryLocation(
  lib: OcgCoreSync,
  handle: OcgDuelHandle,
  controller: number,
  location: OcgLocationValue,
) {
  return lib.duelQueryLocation(handle, { flags: QUERY_FLAGS, controller: controller as 0 | 1, location });
}

function overlayMaterials(controller: number, cards: CardDatabase, overlayCards?: number[]): DuelCard[] {
  if (!overlayCards?.length) return [];
  const materials: DuelCard[] = [];
  overlayCards.forEach((code, overlaySequence) => {
    const material = queryToCard(controller, OcgLocation.OVERLAY, overlaySequence, { code }, cards, undefined);
    if (material) materials.push(material);
  });
  return materials;
}

function projectList(
  viewer: number | null,
  controller: number,
  location: number,
  queries: Array<Partial<OcgCardQueryInfo> | null>,
  cards: CardDatabase,
  reveals: RevealMap,
  partner = false,
): Array<DuelCard | null> {
  return queries.map((query, sequence) => {
    const card = queryToCard(controller, location, sequence, query, cards, undefined);
    if (!card) return null;
    const visible = cardIsVisible({
      viewer,
      controller,
      location,
      position: card.position,
      isPublic: query?.isPublic,
      isHidden: query?.isHidden,
      revealed: slotRevealed(reveals, viewer, controller, location, sequence, query?.code),
      partner,
    });
    return redactCard(card, visible);
  });
}

function compact(list: Array<DuelCard | null>): DuelCard[] {
  return list.filter((card): card is DuelCard => card != null);
}

export function phaseName(phase: OcgPhase): string {
  return ocgPhaseString.get(phase) ?? String(phase);
}

/**
 * The phases the table announces as an event. The Draw and Standby Phase are announced too: the core
 * moves through them whether or not anyone draws or responds, and the client shows each one in turn
 * (a turn start is Draw, Standby, then Main Phase 1). The Battle Phase sub-steps are not announced.
 */
function announcedPhaseTitle(phase: OcgPhase): string | null {
  switch (phase) {
    case OcgPhase.DRAW:
      return "Draw Phase";
    case OcgPhase.STANDBY:
      return "Standby Phase";
    case OcgPhase.MAIN1:
      return "Main Phase 1";
    case OcgPhase.BATTLE_START:
      return "Battle Phase";
    case OcgPhase.MAIN2:
      return "Main Phase 2";
    case OcgPhase.END:
      return "End Phase";
    default:
      return null;
  }
}

export interface StoredChainLink {
  index: number;
  seat: number;
  code: number;
  description?: string;
  zone: DuelZoneRef;
  targets: DuelZoneRef[];
  /** Naming records follow live coordinates; snapshots retain the original targets and records. */
  targetLabels?: Record<string, TargetLabel>;
  chosenOptions?: DuelChainLink["chosenOptions"];
}

export interface StoredDuelEvent {
  id: number;
  kind: DuelEvent["kind"];
  seat?: number;
  card?: DuelCardInfo;
  chainIndex?: number;
  chosenOptions?: DuelChainLink["chosenOptions"];
  text: string;
  publicText: string;
  description?: string;
  toss?: DuelEvent["toss"];
  /** Seats allowed to see `card`/`text`/`description`: everyone, one seat, or a list (empty = nobody). */
  revealCardTo: "all" | number | readonly number[];
  /** Board positions are public information; only `card` and `text` are audience-gated. */
  zone?: DuelZoneRef;
  from?: DuelZoneRef;
  reason?: DuelMoveReason;
  faceDown?: boolean;
  addedToHand?: true;
  moveId?: number;
  target?: DuelZoneRef;
  targetSeat?: number;
  battle?: DuelEvent["battle"];
  targets?: DuelZoneRef[];
  targetLabels?: DuelEvent["targetLabels"];
  /** Internal: a fresh targeting, rather than an ordinary board-marker update. */
  targetAnnouncement?: true;
  amount?: number;
  cause?: DuelEvent["cause"];
  sourceCode?: number;
  sourceCanonicalCode?: number;
  sourceKind?: DuelEvent["sourceKind"];
  sourceSeat?: number;
  summonKind?: DuelEvent["summonKind"];
  fromPosition?: number;
  toPosition?: number;
  flip?: true;
}

/**
 * Battle Phase step, derived from core messages (the core announces NEW_PHASE only for the Start
 * Step; the other steps are inferred). Mapping, in message order:
 *   NEW_PHASE battle_start                    -> "start"
 *   SELECT_BATTLECMD / ATTACK                 -> "battle"   (the Battle Step: attacks are declared)
 *   NEW_PHASE battle_step                     -> "battle"
 *   DAMAGE_STEP_START / NEW_PHASE damage      -> "damage"
 *   HINT event 40, 41 (start / before calc)   -> "damage"
 *   BATTLE / NEW_PHASE damage_cal / HINT 42   -> "damage-calculation"
 *   HINT event 43, 44 (after calc / end)      -> "damage"
 *   DAMAGE_STEP_END                           -> "battle"
 *   HINT event 25, 29 / NEW_PHASE battle(end) -> "end"     (the End Step)
 *   NEW_PHASE main2 / end, NEW_TURN           -> null
 * Anything else keeps the current step. Outside the Battle Phase only NEW_PHASE battle_start changes it.
 */
export function nextBattleStep(step: DuelBattleStep | null, message: OcgMessage): DuelBattleStep | null {
  switch (message.type) {
    case OcgMessageType.NEW_PHASE:
      switch (message.phase) {
        case OcgPhase.BATTLE_START:
          return "start";
        case OcgPhase.BATTLE_STEP:
          return "battle";
        case OcgPhase.DAMAGE:
          return "damage";
        case OcgPhase.DAMAGE_CAL:
          return "damage-calculation";
        case OcgPhase.BATTLE:
          return "end";
        default:
          return null;
      }
    case OcgMessageType.NEW_TURN:
      return null;
    default:
      break;
  }
  if (step == null) return null;
  switch (message.type) {
    case OcgMessageType.SELECT_BATTLECMD:
    case OcgMessageType.ATTACK:
    case OcgMessageType.DAMAGE_STEP_END:
      return "battle";
    case OcgMessageType.DAMAGE_STEP_START:
      return "damage";
    case OcgMessageType.BATTLE:
      return "damage-calculation";
    case OcgMessageType.HINT: {
      if (message.hint_type !== OcgHintType.EVENT) return step;
      const hint = Number(message.hint);
      if (hint === 40 || hint === 41 || hint === 43 || hint === 44) return "damage";
      if (hint === 42) return "damage-calculation";
      if (hint === 25 || hint === 29) return "end";
      return step;
    }
    default:
      return step;
  }
}

/**
 * Prefix of the Debug.Message line the engine's startup script prints when a card is destroyed.
 * Supplies destruction cause and source details, including notes that arrive after their MOVE message.
 */
export const DESTROY_NOTE_PREFIX = "YGD:DESTROY:";

export const CHAIN_TARGET_NOTE_PREFIX = "YGD:CHAIN_TARGET:";

/** ChangeTargetCard emits a target message without its link number or EVENT_BECOME_TARGET.
 * Report the changed link and its cards; TypeScript applies the same privacy filter as for fresh targets.
 * The original core call still performs every game-state change. */
export const CHAIN_TARGET_NOTE_SCRIPT = `
${TARGET_CARD_NOTE_LUA}
local changeTargetCard=Duel.ChangeTargetCard
Duel.ChangeTargetCard=function(index,targets)
  changeTargetCard(index,targets)
  local count=Duel.GetCurrentChain()
  if count==0 then return end
  if index<1 or index>count then index=count end
  local g,re=Duel.GetChainInfo(index,CHAININFO_TARGET_CARDS,CHAININFO_TRIGGERING_EFFECT)
  if not g or not re or not re:IsHasProperty(EFFECT_FLAG_CARD_TARGET) then return end
  local zones={}
  for tc in aux.Next(g) do
    local controller=Duel.MPSeatOf and Duel.MPSeatOf(tc) or tc:GetControler()
    zones[#zones+1]=controller..":"..tc:GetLocation()..":"..tc:GetSequence()
    pcall(noteTargetCard,tc)
  end
  Debug.Message("${CHAIN_TARGET_NOTE_PREFIX}"..index..";"..table.concat(zones,","))
end`;

/**
 * Startup script that reports destroyed cards. Registers one global continuous effect and changes no game state.
 * A Lua error here would stop the duel, so each note runs in pcall. The reason effect is used only when it
 * is an Effect (only Effects have SetLabelObject): an older core could hand back a freed effect's stale ref.
 */
export const DESTROY_NOTE_SCRIPT = `
local function note(tc)
  local re=tc:GetReasonEffect()
  if re and not re.SetLabelObject then re=nil end
  local rc=tc:GetReasonCard()
  local rtype=0
  if re then
    rc=re:GetHandler()
    rtype=re:GetActiveType()
  elseif rc then
    rtype=rc:GetType()
  end
  local rcode=0
  if rc then rcode=rc:GetOriginalCode() end
  Debug.Message("${DESTROY_NOTE_PREFIX}"..tc:GetPreviousControler()..":"..tc:GetPreviousLocation()..":"..tc:GetPreviousSequence()
    ..":"..tc:GetReason()..":"..rcode..":"..rtype..":"..tc:GetReasonPlayer())
end
local e=Effect.GlobalEffect()
e:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS)
e:SetCode(EVENT_DESTROYED)
e:SetOperation(function(e,tp,eg)
  for tc in aux.Next(eg) do pcall(note,tc) end
end)
Duel.RegisterEffect(e,0)
`;

interface PendingMove {
  code: number;
  from: { controller: number; location: number; sequence: number; position: number };
  /** The chain link that was resolving when the card left: its note may only arrive after CHAIN_SOLVED. */
  resolving: EventContext["resolving"];
}

/** Mutable per-duel state the event observer needs across messages. */
export interface EventContext {
  /** Between a BATTLE message and the end of the damage step, DAMAGE is battle damage. */
  battle: boolean;
  /** A MOVE carried RELEASE | SUMMON | MATERIAL for the pending Normal Summon or monster Set. */
  summonTribute: boolean;
  /** Destruction notes printed by the startup script and not yet matched to a MOVE. */
  destroyNotes: string[];
  /** Coordinates and changed link numbers omitted from the core's BECOME_TARGET messages. */
  chainTargetNotes: Array<{ index: number; targets: DuelZoneRef[] }>;
  /** Cards printed by the startup script as they became targets, not yet matched to a BECOME_TARGET message. */
  targetNotes: TargetCardNote[];
  /** The chain link currently resolving (CHAIN_SOLVING .. CHAIN_SOLVED); the fallback source of an effect destroy. */
  resolving: { index: number; code: number; seat: number; type: number } | null;
  /** Field departures seen before their destruction note arrived. */
  pendingMoves: PendingMove[];
  /** Move events emitted this batch whose reason a later message may still refine. */
  moves: TrackedMove[];
  /** Cards in each hand, so DRAW messages (which carry no sequence) can be given a hand slot. */
  handSize: number[];
  /** Animation identities of the cards in each hand (engine order stays the truth). */
  handIdentities: HandIdentities;
  /** Seat and team layout, for who may see a moved card (a Tag partner sees hands and Set cards). */
  format: DuelFormat;
  /** Location each field zone's current card arrived from (zone key -> location bit), kept across batches. */
  arrivals: Map<string, number>;
  /** The answer that started the current summon was a Pendulum Summon (a Pendulum Zone card's summon action). */
  pendulumSummon: boolean;
  /** Material MOVE reason bits for the current summon group, until SPSUMMONED. Includes Xyz overlays. */
  materialReasons: number;
}

interface TrackedMove {
  event: StoredDuelEvent;
  from: DuelZoneRef;
  to: DuelZoneRef;
  /** A summon/set/activate/destroy signal already fixed the reason. */
  settled: boolean;
}

export function createEventContext(format: DuelFormat = "1v1"): EventContext {
  const seats = seatCountFor(format);
  return {
    battle: false,
    summonTribute: false,
    destroyNotes: [],
    chainTargetNotes: [],
    targetNotes: [],
    resolving: null,
    pendingMoves: [],
    moves: [],
    handSize: new Array<number>(seats).fill(0),
    handIdentities: new HandIdentities(seats),
    format,
    arrivals: new Map(),
    pendulumSummon: false,
    materialReasons: 0,
  };
}

/** Internal notes arrive during core processing, before its buffered messages are consumed. */
export function noteChainTargetLog(ctx: EventContext, text: string): boolean {
  if (!text.startsWith(CHAIN_TARGET_NOTE_PREFIX)) return false;
  const [rawIndex, rawTargets] = text.slice(CHAIN_TARGET_NOTE_PREFIX.length).split(";");
  const index = Number(rawIndex);
  const targets = rawTargets ? rawTargets.split(",").map((raw) => {
    const [controller, location, sequence] = raw.split(":").map(Number);
    return { controller, location, sequence };
  }) : [];
  if (Number.isInteger(index) && index > 0 && rawTargets != null && targets.every((zone) =>
    Number.isInteger(zone.controller) && zone.controller >= 0 && zone.controller < ctx.handSize.length && Number.isInteger(zone.location) && zone.location >= 0 &&
    Number.isInteger(zone.sequence) && zone.sequence >= 0)) ctx.chainTargetNotes.push({ index, targets });
  return true;
}

/** Internal notes arrive during core processing, before its buffered messages are consumed. */
export function noteTargetCardLog(ctx: EventContext, text: string): boolean {
  if (!text.startsWith(TARGET_CARD_NOTE_PREFIX)) return false;
  const note = parseTargetCardNote(text);
  if (note) ctx.targetNotes.push(note);
  return true;
}

/** Feed an engine log line to the context; returns true when it was a destruction note. */
export function noteDestroyLog(ctx: EventContext, text: string): boolean {
  if (!text.startsWith(DESTROY_NOTE_PREFIX)) return false;
  ctx.destroyNotes.push(text.slice(DESTROY_NOTE_PREFIX.length));
  return true;
}

interface DestroyDetail {
  cause: NonNullable<DuelEvent["cause"]>;
  sourceCode?: number;
  sourceCanonicalCode?: number;
  sourceKind?: NonNullable<DuelEvent["sourceKind"]>;
  sourceSeat?: number;
}

const REASON_BATTLE = 0x20;
const REASON_EFFECT = 0x40;
const REASON_COST = 0x80;
const REASON_RULE = 0x400;

/** Read the optional ":reason:rcode:rtype:rplayer" tail of a destruction note. Undefined for old three-part notes. */
function parseDestroyDetail(resolving: EventContext["resolving"], tail: string[], format?: DuelFormat): DestroyDetail | undefined {
  if (tail.length < 4) return undefined;
  const [reason, code, type, player] = tail.map(Number) as [number, number, number, number];
  if ([reason, code, type, player].some((value) => !Number.isFinite(value))) return undefined;
  const cause: DestroyDetail["cause"] =
    reason & REASON_BATTLE ? "battle" : reason & REASON_EFFECT ? "effect" : reason & REASON_COST ? "cost" : reason & REASON_RULE ? "rule" : "other";
  const detail: DestroyDetail = { cause };
  let sourceCode = code;
  let sourceType = type;
  let sourceSeat = player;
  if (!sourceCode && cause === "effect" && resolving) {
    // The core gave no reason card: attribute the destroy to the chain link that is resolving.
    sourceCode = resolving.code;
    sourceSeat = resolving.seat;
    sourceType = resolving.type;
  }
  if (sourceCode) {
    detail.sourceCode = sourceCode;
    // A rule effect has reason player 0xFF at three or more seats: no source seat.
    if (!isNoDuelist(format, sourceSeat)) detail.sourceSeat = sourceSeat;
    const kind = sourceType & OcgType.TRAP ? "trap" : sourceType & OcgType.SPELL ? "spell" : sourceType & OcgType.MONSTER ? "monster" : undefined;
    if (kind) detail.sourceKind = kind;
  }
  return detail;
}

function takeDestroyNote(
  ctx: EventContext,
  cards: CardDatabase,
  from: { controller: number; location: number; sequence: number },
  resolving: EventContext["resolving"] = ctx.resolving,
): DestroyDetail | true | null {
  const key = `${from.controller}:${from.location}:${from.sequence}`;
  const index = ctx.destroyNotes.findIndex((note) => note === key || note.startsWith(`${key}:`));
  if (index < 0) return null;
  const [note] = ctx.destroyNotes.splice(index, 1);
  const detail = parseDestroyDetail(resolving, note!.split(":").slice(3), ctx.format);
  if (detail?.sourceCode != null) {
    detail.sourceCanonicalCode = cards.get(detail.sourceCode)?.canonicalPasscode ?? detail.sourceCode;
  }
  const settled = settleMove(ctx, (move) => sameZone(move.from, from), "destroy");
  if (detail && settled) applyDestroyDetail(settled, detail);
  return detail ?? true;
}

function applyDestroyDetail(event: StoredDuelEvent, detail: DestroyDetail): void {
  event.cause = detail.cause;
  if (detail.sourceCode != null) event.sourceCode = detail.sourceCode;
  if (detail.sourceCanonicalCode != null) event.sourceCanonicalCode = detail.sourceCanonicalCode;
  if (detail.sourceKind) event.sourceKind = detail.sourceKind;
  if (detail.sourceSeat != null) event.sourceSeat = detail.sourceSeat;
}

function isFieldLocation(location: number): boolean {
  return location === OcgLocation.MZONE || location === OcgLocation.SZONE;
}

// Native reason bits from ygopro-core/ocgapi_constants.h and the pinned constant.lua. REASON_LINK differs
// from TYPE_LINK (0x4000000): that bit in a MOVE reason is REASON_REDIRECT.
const REASON_RELEASE = 0x2;
const REASON_MATERIAL = 0x8;
const REASON_SUMMON = 0x10;
const TRIBUTE_MATERIAL_REASON = REASON_RELEASE | REASON_MATERIAL | REASON_SUMMON;
const REASON_FUSION = 0x40000;
const REASON_SYNCHRO = 0x80000;
const REASON_RITUAL = 0x100000;
const REASON_XYZ = 0x200000;
const REASON_LINK = 0x10000000;

/** A method needs matching material reasons, card type and origin; the Pendulum flag takes precedence. */
function specialSummonKind(ctx: EventContext, message: { controller: number; location: number; sequence: number }, type: number): DuelSummonKind {
  if (ctx.pendulumSummon) return "pendulum";
  const from = ctx.arrivals.get(slotKey(message.controller, message.location, message.sequence));
  if (from == null) return "special";
  // The byte-sized MOVE location reports the 0x4000 Deck Master Zone as 0 (no other source is 0).
  const master = from === LOCATION_DECKMASTER || from === 0;
  const extra = from === OcgLocation.EXTRA || master;
  if (extra) {
    if ((type & OcgType.FUSION) && (ctx.materialReasons & REASON_FUSION)) return "fusion";
    if ((type & OcgType.SYNCHRO) && (ctx.materialReasons & REASON_SYNCHRO)) return "synchro";
    if ((type & OcgType.XYZ) && (ctx.materialReasons & REASON_XYZ)) return "xyz";
    if ((type & OcgType.LINK) && (ctx.materialReasons & REASON_LINK)) return "link";
  }
  if ((from === OcgLocation.HAND || master) && (type & OcgType.RITUAL) && (ctx.materialReasons & REASON_RITUAL)) return "ritual";
  return "special";
}

function clearSummonMaterials(ctx: EventContext): void {
  ctx.materialReasons = 0;
  ctx.summonTribute = false;
}

function destroyEvent(id: number, code: number, from: PendingMove["from"], cards: CardDatabase, detail?: DestroyDetail | true, format?: DuelFormat): StoredDuelEvent {
  const info = code ? cards.get(code) : undefined;
  const name = info?.name ?? (code ? `Card ${code}` : "A card");
  const hidden = isFacedownPosition(from.position);
  const text = `${name} was destroyed`;
  const event: StoredDuelEvent = {
    id,
    kind: "destroy",
    seat: seatOf(format, from.controller),
    card: info,
    text,
    publicText: hidden ? "A face-down card was destroyed" : text,
    revealCardTo: hidden ? audienceOf(format, from.controller) : "all",
    zone: zoneRefOf(format, from),
  };
  if (from.location === OcgLocation.MZONE) event.fromPosition = from.position;
  if (detail && detail !== true) applyDestroyDetail(event, detail);
  return event;
}

/** Destroy events whose note arrived after their MOVE message (they were split across engine batches). */
export function drainDeferredDestroys(ctx: EventContext, cards: CardDatabase, firstId: number): StoredDuelEvent[] {
  const out: StoredDuelEvent[] = [];
  const remaining: PendingMove[] = [];
  for (const move of ctx.pendingMoves) {
    const detail = takeDestroyNote(ctx, cards, move.from, move.resolving);
    if (detail) {
      out.push(destroyEvent(firstId + out.length, move.code, move.from, cards, detail, ctx.format));
    } else remaining.push(move);
  }
  ctx.pendingMoves = remaining;
  return out;
}

/** Clear batch state; position/place prompts can interrupt a summon after its materials have moved. */
export function resetEventBatch(ctx: EventContext, continuingSummon = false): void {
  ctx.destroyNotes.length = 0;
  ctx.chainTargetNotes.length = 0;
  ctx.pendingMoves.length = 0;
  ctx.moves.length = 0;
  if (!continuingSummon) clearSummonMaterials(ctx);
}

export function projectStoredEvent(event: StoredDuelEvent, viewer: number | null): DuelEvent {
  const audience = event.revealCardTo;
  const reveal =
    audience === "all" ||
    (viewer != null && (typeof audience === "number" ? viewer === audience : audience.includes(viewer)));
  const projected: DuelEvent = {
    id: event.id,
    kind: event.kind,
    text: reveal ? event.text : event.publicText,
  };
  if (event.seat != null) projected.seat = event.seat;
  if (event.chainIndex != null) projected.chainIndex = event.chainIndex;
  if (event.chosenOptions) projected.chosenOptions = event.chosenOptions.map((choice) => ({ ...choice }));
  if (event.toss) projected.toss = event.toss.type === "coin"
    ? { type: "coin", results: [...event.toss.results] }
    : { type: "dice", results: [...event.toss.results] };
  if (event.zone) projected.zone = { ...event.zone };
  if (event.target) projected.target = { ...event.target };
  if (event.targetSeat != null) projected.targetSeat = event.targetSeat;
  if (event.battle) projected.battle = {
    attacker: { ...event.battle.attacker },
    ...(event.battle.target ? { target: { ...event.battle.target } } : {}),
  };
  if (event.targets) projected.targets = event.targets.map(zoneOf);
  if (event.targetLabels) projected.targetLabels = [...event.targetLabels];
  if (event.from) projected.from = { ...event.from };
  if (event.reason) projected.reason = event.reason;
  if (event.faceDown != null) projected.faceDown = event.faceDown;
  if (event.addedToHand) projected.addedToHand = true;
  if (event.moveId != null) projected.moveId = event.moveId;
  if (event.amount != null) projected.amount = event.amount;
  if (event.cause) projected.cause = event.cause;
  if (event.sourceCode != null) projected.sourceCode = event.sourceCode;
  if (event.sourceCanonicalCode != null) projected.sourceCanonicalCode = event.sourceCanonicalCode;
  if (event.sourceKind) projected.sourceKind = event.sourceKind;
  if (event.sourceSeat != null) projected.sourceSeat = event.sourceSeat;
  if (event.summonKind) projected.summonKind = event.summonKind;
  if (event.fromPosition != null) projected.fromPosition = event.fromPosition;
  if (event.toPosition != null) projected.toPosition = event.toPosition;
  if (event.flip) projected.flip = true;
  if (reveal && event.card) projected.card = event.card;
  if (reveal && event.description) projected.description = event.description;
  return projected;
}

/** MSG_ATTACK_DUELIST follows a direct MSG_ATTACK; its defender is public, including to bystanders. */
export function noteDirectAttackTarget(event: StoredDuelEvent, controller: number, format: DuelFormat): void {
  const targetSeat = seatOf(format, controller);
  if (event.kind !== "attack" || event.target || event.seat == null || targetSeat == null) return;
  event.targetSeat = targetSeat;
  event.text = `${playerLabel(format, event.seat)} attacks ${playerLabel(format, controller)} directly`;
  event.publicText = event.text;
}

function chainLinkEvent(
  id: number,
  kind: "chain-resolving" | "chain-resolved" | "chain-negated",
  chainSize: number,
  chain: StoredChainLink[],
  cards: CardDatabase,
  verb: string,
  format?: DuelFormat,
): StoredDuelEvent {
  const link = chain[chainSize - 1];
  const info = link ? cards.get(link.code) : undefined;
  const label = info?.name ?? (link ? `Card ${link.code}` : `Chain link ${chainSize}`);
  const text = `Chain link ${chainSize} (${label}) ${verb}`;
  return {
    id,
    kind,
    seat: link && !isNoDuelist(format, link.seat) ? link.seat : undefined,
    card: info,
    chainIndex: chainSize,
    text,
    publicText: text,
    description: link?.description,
    revealCardTo: "all",
  };
}

function zoneOf(place: { controller: number; location: number; sequence: number }): DuelZoneRef {
  return { controller: place.controller, location: place.location, sequence: place.sequence };
}

function sameZone(a: DuelZoneRef, b: DuelZoneRef): boolean {
  return a.controller === b.controller && a.location === b.location && a.sequence === b.sequence;
}

function confirmedMove(card: DuelZoneRef & { code: number }, ctx: EventContext): TrackedMove | undefined {
  return [...ctx.moves].reverse().find((move) => sameZone(move.to, card) && move.event.card?.code === card.code);
}

/** Public only when linked to the controller's own Deck-to-hand/field move this batch. */
export function confirmationAudience(card: DuelZoneRef & { code: number }, recipient: number, ctx: EventContext): "all" | number {
  const move = confirmedMove(card, ctx);
  return move && move.from.location === OcgLocation.DECK &&
    (move.to.location & (OcgLocation.HAND | OcgLocation.ONFIELD)) !== 0 &&
    move.from.controller === card.controller && move.to.controller === card.controller ? "all" : recipient;
}

/** Capture one immutable identity per confirmed card, independently of the live RevealMap. */
export function observeConfirmEvents(message: OcgMessage, cards: CardDatabase, ctx: EventContext, firstId: number): StoredDuelEvent[] {
  if (message.type !== OcgMessageType.CONFIRM_CARDS) return [];
  return message.cards.map((card, index) => {
    const info = cards.get(card.code);
    const zone = zoneOf(card);
    const move = confirmedMove(card, ctx);
    return {
      id: firstId + index,
      kind: "confirm",
      seat: card.controller,
      card: info ? { ...info } : undefined,
      zone,
      moveId: move?.event.id,
      text: `Confirmed ${info?.name ?? `Card ${card.code}`}`,
      publicText: "A card was confirmed",
      revealCardTo: confirmationAudience(card, message.player, ctx),
    };
  });
}

function zoneKeyOf(zone: DuelZoneRef): string {
  return `${zone.controller}:${zone.location}:${zone.sequence}`;
}

/** The targets of a link as a phrase for the log: names of public cards, "a face-down card", or the count. */
export function linkTargetPhrase(link: StoredChainLink): string {
  return chainTargetPhrase(link.targets.map((zone) => link.targetLabels?.[zoneKeyOf(zone)]?.label), link.targets.length);
}

/**
 * Give each target of a link its public label from the notes the startup script printed (target-names.ts). The core
 * may deliver a note in a later process call than the BECOME_TARGET message, so the engine calls this again after
 * every call until it returns true (every target named). Only what the table can see is named.
 */
export function nameLinkTargets(ctx: EventContext, link: StoredChainLink, cards: CardDatabase): boolean {
  let complete = true;
  for (const zone of link.targets) {
    const key = zoneKeyOf(zone);
    const target = (link.targetLabels ??= {})[key] ??= { zone: zoneOf(zone) };
    if (target.label != null) continue;
    const at = ctx.targetNotes.findIndex((entry) => sameZone(entry, target.zone));
    if (at < 0) {
      complete = false;
      continue;
    }
    const note = ctx.targetNotes.splice(at, 1)[0]!;
    target.label = publicTargetLabel({ location: note.location, position: note.position, name: cards.get(note.code)?.name });
  }
  return complete;
}

/** Coordinates and target membership are frozen; only the original targets' missing names can settle later. */
export function snapshotLinkTargets(link: StoredChainLink): StoredChainLink {
  return { ...link, targets: link.targets.map(zoneOf), targetLabels: { ...link.targetLabels } };
}

/** Public names belong to announcements, never to the live board coordinates of a moved target. */
export function targetEventLabels(link: StoredChainLink): string[] {
  return link.targets.map((zone) => link.targetLabels?.[zoneKeyOf(zone)]?.label ?? "a card");
}

export function targetEventText(link: StoredChainLink): string {
  return `Chain Link ${link.index} targets ${linkTargetPhrase(link)}`;
}

function targetEvent(link: StoredChainLink, id: number, announcement = false): StoredDuelEvent {
  const text = targetEventText(link);
  return { id, kind: "target", seat: link.seat, chainIndex: link.index,
    targets: link.targets.map(zoneOf), text, publicText: text, revealCardTo: "all",
    ...(announcement ? { targetAnnouncement: true as const } : {}) };
}

/** BECOME_TARGET has no link number: append while building the newest link, replace while resolving.
 * ChangeTargetCard notes identify changes to earlier links; CHAIN_SOLVING is the fallback.
 * Keep this memory across waits; queries expose the source of each link but omit its targets.
 * Target updates contain only coordinates, so they cannot bypass the board's identity redaction. */
export function observeChainTargetEvents(message: OcgMessage, chain: StoredChainLink[], id: number, ctx?: EventContext, cards?: CardDatabase): StoredDuelEvent[] {
  if (message.type === OcgMessageType.BECOME_TARGET) {
    const noteIndex = ctx?.resolving ? ctx.chainTargetNotes.findIndex((note) =>
      note.targets.length === message.cards.length && note.targets.every((zone) => message.cards.some((card) => sameZone(zone, card)))) : -1;
    const note = noteIndex >= 0 ? ctx!.chainTargetNotes.splice(noteIndex, 1)[0] : undefined;
    const link = ctx?.resolving ? chain[(note?.index ?? ctx.resolving.index) - 1] : chain.at(-1);
    if (!link) return [];
    if (ctx?.resolving) {
      link.targets = [];
      link.targetLabels = undefined;
    }
    for (const card of message.cards) {
      const zone = zoneOf(card);
      if (!link.targets.some((target) => sameZone(target, zone))) link.targets.push(zone);
    }
    // Create each naming record before any coordinate changes. Announcements and the live link share these
    // write-once records, so one delayed note completes every snapshot that includes the same target.
    for (const zone of link.targets) (link.targetLabels ??= {})[zoneKeyOf(zone)] ??= { zone: zoneOf(zone) };
    if (ctx && cards) nameLinkTargets(ctx, link, cards);
    return [targetEvent(link, id, true)];
  }

  // Follow the actual card, never the next occupant of its old slot. Lists also compact on removal
  // and shift on insertion. Hidden shuffles erase tracking instead of publishing the secret order.
  let transform: ((zone: DuelZoneRef) => DuelZoneRef | null) | undefined;
  const inList = (location: number) => (location & (OcgLocation.DECK | OcgLocation.HAND | OcgLocation.GRAVE | OcgLocation.REMOVED | OcgLocation.EXTRA)) !== 0;
  const at = (zone: DuelZoneRef, controller: number, location: number) => zone.controller === controller && zone.location === location;
  switch (message.type) {
    case OcgMessageType.MOVE: {
      const { from, to } = message;
      if (sameZone(from, to)) return [];
      transform = (zone) => {
        if (sameZone(zone, from)) return to.location ? zoneOf(to) : null;
        let sequence = zone.sequence;
        if (inList(from.location) && at(zone, from.controller, from.location) && sequence > from.sequence) sequence -= 1;
        if (inList(to.location) && at(zone, to.controller, to.location) && sequence >= to.sequence) sequence += 1;
        return { ...zone, sequence };
      };
      break;
    }
    case OcgMessageType.SWAP:
      transform = (zone) => sameZone(zone, message.card1) ? zoneOf(message.card2)
        : sameZone(zone, message.card2) ? zoneOf(message.card1) : zone;
      break;
    case OcgMessageType.REMOVE_CARDS:
      // All coordinates in this message describe the board before any removal.
      transform = (zone) => {
        if (message.cards.some((card) => sameZone(zone, card))) return null;
        const removedBefore = message.cards.filter((card) => inList(card.location) &&
          at(zone, card.controller, card.location) && card.sequence < zone.sequence).length;
        return { ...zone, sequence: zone.sequence - removedBefore };
      };
      break;
    case OcgMessageType.SWAP_GRAVE_DECK:
      // The new deck is hidden; Extra Deck returns can also shift that pile.
      transform = (zone) => zone.controller === message.player &&
        (zone.location === OcgLocation.DECK || zone.location === OcgLocation.GRAVE || zone.location === OcgLocation.EXTRA) ? null : zone;
      break;
    case OcgMessageType.REVERSE_DECK:
      // No deck sizes/order in the message: do not infer a hidden card's new slot.
      transform = (zone) => zone.location === OcgLocation.DECK ? null : zone;
      break;
    case OcgMessageType.DRAW:
      if (message.drawn.length === 0) return [];
      // DRAW has no MOVE or source sequence, so forget targets in the changed deck.
      transform = (zone) => at(zone, message.player, OcgLocation.DECK) ? null : zone;
      break;
    case OcgMessageType.TAG_SWAP:
      transform = (zone) => zone.controller === message.player &&
        (zone.location === OcgLocation.DECK || zone.location === OcgLocation.HAND || zone.location === OcgLocation.EXTRA) ? null : zone;
      break;
    case OcgMessageType.RELOAD_FIELD:
      transform = () => null;
      break;
    case OcgMessageType.DECK_TOP:
      // Reveals a card/count, without moving it. Prior MOVE/DRAW/REVERSE_DECK handles changes.
      return [];
    case OcgMessageType.SHUFFLE_SET_CARD:
      transform = (zone) => message.cards.some((card) => sameZone(zone, card.from)) ? null : zone;
      break;
    case OcgMessageType.SHUFFLE_DECK:
    case OcgMessageType.SHUFFLE_HAND:
    case OcgMessageType.SHUFFLE_EXTRA: {
      const location = message.type === OcgMessageType.SHUFFLE_DECK ? OcgLocation.DECK
        : message.type === OcgMessageType.SHUFFLE_HAND ? OcgLocation.HAND : OcgLocation.EXTRA;
      transform = (zone) => at(zone, message.player, location) ? null : zone;
      break;
    }
    default:
      return [];
  }
  const events: StoredDuelEvent[] = [];
  for (const link of chain) {
    const targets = link.targets.map(transform).filter((zone): zone is DuelZoneRef => zone != null);
    if (targets.length === link.targets.length && targets.every((zone, index) => sameZone(zone, link.targets[index]))) continue;
    const labels: Record<string, TargetLabel> = {};
    for (const zone of link.targets) {
      const moved = transform(zone);
      const label = link.targetLabels?.[zoneKeyOf(zone)];
      if (moved && label) labels[zoneKeyOf(moved)] = label;
    }
    link.targets = targets;
    link.targetLabels = labels;
    events.push(targetEvent(link, id + events.length));
  }
  return events;
}

/** Fix the reason of the most recent still-unsettled move this batch that matches `test`. */
function settleMove(ctx: EventContext, test: (move: TrackedMove) => boolean, reason: DuelMoveReason): StoredDuelEvent | undefined {
  for (let index = ctx.moves.length - 1; index >= 0; index -= 1) {
    const move = ctx.moves[index]!;
    if (move.settled || !test(move)) continue;
    move.settled = true;
    move.event.reason = reason;
    return move.event;
  }
  return undefined;
}

/** True when `viewer` may learn a card's identity from this end of a move. */
function moveEndVisible(viewer: number, place: { controller: number; location: number; position?: number }, format: DuelFormat): boolean {
  const own = viewer === place.controller;
  const partner = partnerSeatOf(format, viewer) === place.controller;
  if (place.location === OcgLocation.DECK) return own;
  if (place.location === OcgLocation.HAND) return own || partner;
  return cardIsVisible({
    viewer,
    controller: place.controller,
    location: place.location,
    position: place.position ?? OcgPosition.FACEUP,
    partner,
  });
}

/**
 * A card's identity is shown to a viewer only if it is public at the source or destination for
 * them, or they control the hand/deck it moves from or to. Never widen this without a privacy test.
 */
function moveAudience(
  from: PendingMove["from"],
  to: { controller: number; location: number; position?: number },
  format: DuelFormat,
): "all" | number | readonly number[] {
  const seats = Array.from({ length: seatCountFor(format) }, (_, seat) => seat).filter(
    (seat) => moveEndVisible(seat, from, format) || moveEndVisible(seat, to, format),
  );
  if (seats.length < 2) return seats.length === 1 ? seats[0]! : [];
  // Both seats know the card. A spectator knows it only if it is public at one end. A face-down
  // card that changes control is known to both players and to nobody else.
  const spectatorSees = [from, to].some((end) =>
    cardIsVisible({ viewer: null, controller: end.controller, location: end.location, position: end.position ?? OcgPosition.FACEUP }),
  );
  return spectatorSees ? "all" : seats;
}

function defaultMoveReason(from: number, to: number): DuelMoveReason {
  if (to === OcgLocation.GRAVE) return from === OcgLocation.HAND ? "discard" : "send";
  if (to === OcgLocation.REMOVED) return "banish";
  // This default is for MSG_MOVE. Actual draws arrive through MSG_DRAW below.
  if (to === OcgLocation.HAND) return from === OcgLocation.DECK ? "add" : "return";
  if (to === OcgLocation.DECK || to === OcgLocation.EXTRA) return "return";
  return "other";
}

function trackMove(
  ctx: EventContext,
  id: number,
  cards: CardDatabase,
  code: number,
  from: PendingMove["from"],
  to: { controller: number; location: number; sequence: number; position?: number },
  reason: DuelMoveReason,
): StoredDuelEvent {
  const info = code ? cards.get(code) : undefined;
  const name = info?.name ?? (code ? `Card ${code}` : "A card");
  const fromZone = zoneOf(from);
  const toZone = zoneOf(to);
  const event: StoredDuelEvent = {
    id,
    kind: "move",
    seat: seatOf(ctx.format, to.controller),
    card: info,
    text: `${name} moved`,
    publicText: "A card moved",
    revealCardTo: moveAudience(from, to, ctx.format),
    zone: zoneRefOf(ctx.format, to),
    from: zoneRefOf(ctx.format, from),
    reason,
  };
  if (from.location === OcgLocation.MZONE) event.fromPosition = from.position;
  if (to.location === OcgLocation.MZONE || to.location === OcgLocation.SZONE || to.location === OcgLocation.REMOVED || to.location === LOCATION_DECKMASTER) {
    event.faceDown = isFacedownPosition(to.position);
  }
  ctx.moves.push({ event, from: fromZone, to: toZone, settled: false });
  return event;
}

/**
 * "move" events, emitted in engine order. Called for every message BEFORE observeDuelEvent so a move
 * precedes the summon/set/activate/destroy event it belongs to. The engine emits MOVE before
 * SUMMONING/SET/CHAINING, so those messages only refine the reason of the move that just happened:
 *   ->MZONE then SUMMONING/SPSUMMONING = "summon", ->MZONE/SZONE then SET = "set",
 *   ->SZONE then CHAINING = "activate", field->GY with a destroy note = "destroy".
 * Unrefined moves keep the location-based default (see defaultMoveReason). Skipped: moves within one
 * zone (deck/extra/hand shuffles, zone swaps) and moves to or from the overlay pile.
 */
export function observeMoveEvents(message: OcgMessage, cards: CardDatabase, ctx: EventContext, firstId: number): StoredDuelEvent[] {
  switch (message.type) {
    case OcgMessageType.REMOVE_CARDS:
      for (const card of [...message.cards].sort((a, b) => b.sequence - a.sequence)) {
        if (card.location !== OcgLocation.HAND) continue;
        if (isNoDuelist(ctx.format, card.controller)) continue;
        ctx.handIdentities.remove(card.controller, card.sequence);
        ctx.handSize[card.controller] = Math.max(0, (ctx.handSize[card.controller] ?? 0) - 1);
      }
      return [];
    case OcgMessageType.SHUFFLE_HAND:
      ctx.handIdentities.shuffle(message.player, message.cards);
      if (message.player >= 0 && message.player < ctx.handSize.length) ctx.handSize[message.player] = message.cards.length;
      return [];
    case OcgMessageType.POS_CHANGE:
      if (message.location === OcgLocation.HAND) {
        ctx.handIdentities.setPublic(message.controller, message.sequence, message.code, (message.position & OcgPosition.FACEUP) !== 0);
      }
      return [];
    case OcgMessageType.DRAW: {
      const seat = message.player;
      const out: StoredDuelEvent[] = [];
      message.drawn.forEach((drawn, index) => {
        const from = { controller: seat, location: OcgLocation.DECK as number, sequence: 0, position: OcgPosition.FACEDOWN_DEFENSE as number };
        const to = { controller: seat, location: OcgLocation.HAND as number, sequence: (ctx.handSize[seat] ?? 0) + index, position: drawn.position as number };
        out.push(trackMove(ctx, firstId + out.length, cards, drawn.code, from, to, "draw"));
        ctx.handIdentities.add(seat, drawn.code, to.sequence, firstId + out.length - 1, (drawn.position & OcgPosition.FACEUP) !== 0);
      });
      ctx.handSize[seat] = (ctx.handSize[seat] ?? 0) + message.drawn.length;
      return out;
    }
    case OcgMessageType.MOVE: {
      const { from, to } = message;
      // Collect before filtering move events so Xyz overlay materials also prove the method.
      // patches/ocgcore-wasm+0.1.2.patch parses the trailing reason; the published types do not declare it.
      const materialReason = (message as typeof message & { reason?: number }).reason ?? 0;
      if (materialReason & REASON_MATERIAL) ctx.materialReasons |= materialReason;
      if ((materialReason & TRIBUTE_MATERIAL_REASON) === TRIBUTE_MATERIAL_REASON) ctx.summonTribute = true;
      if (from.location === OcgLocation.HAND && to.location === OcgLocation.HAND && from.controller === to.controller) {
        ctx.handIdentities.relocate(from.controller, from.sequence, to.sequence);
        ctx.handIdentities.setPublic(to.controller, to.sequence, message.card, (to.position & OcgPosition.FACEUP) !== 0);
        return [];
      }
      const overlay = OcgLocation.OVERLAY as number;
      const event = from.location && to.location && from.location !== overlay && to.location !== overlay
        && !(from.controller === to.controller && from.location === to.location)
        ? trackMove(ctx, firstId, cards, message.card, from, to, defaultMoveReason(from.location, to.location))
        : undefined;
      if (from.location === OcgLocation.HAND) ctx.handIdentities.remove(from.controller, from.sequence);
      // Skipped moves still update slot identities, but must not claim the next emitted event's id.
      if (to.location === OcgLocation.HAND) ctx.handIdentities.add(to.controller, message.card, to.sequence, event?.id,
        (to.position & OcgPosition.FACEUP) !== 0, event?.revealCardTo === "all" ? message.card : undefined);
      if (from.location === OcgLocation.HAND && !isNoDuelist(ctx.format, from.controller)) ctx.handSize[from.controller] = Math.max(0, (ctx.handSize[from.controller] ?? 0) - 1);
      if (to.location === OcgLocation.HAND && !isNoDuelist(ctx.format, to.controller)) ctx.handSize[to.controller] = (ctx.handSize[to.controller] ?? 0) + 1;
      if (isFieldLocation(from.location)) ctx.arrivals.delete(slotKey(from.controller, from.location, from.sequence));
      if (isFieldLocation(to.location)) ctx.arrivals.set(slotKey(to.controller, to.location, to.sequence), from.location);
      if (!event) return [];
      // A MOVE to a hand is never a draw (draws arrive as DRAW): a card effect added it.
      if (to.location === OcgLocation.HAND && from.location !== OcgLocation.HAND) event.addedToHand = true;
      return [event];
    }
    case OcgMessageType.SUMMONING:
    case OcgMessageType.SPSUMMONING: {
      const zone = zoneOf(message);
      settleMove(ctx, (move) => sameZone(move.to, zone), "summon");
      return [];
    }
    case OcgMessageType.SET: {
      const zone = zoneOf(message);
      settleMove(ctx, (move) => sameZone(move.to, zone), "set");
      return [];
    }
    case OcgMessageType.CHAINING: {
      const zone = zoneOf(message);
      settleMove(ctx, (move) => sameZone(move.to, zone) && move.to.location === OcgLocation.SZONE, "activate");
      return [];
    }
    default:
      return [];
  }
}

export function observeDuelEvent(
  message: OcgMessage,
  cards: CardDatabase,
  chain: StoredChainLink[],
  id: number,
  ctx?: EventContext,
): StoredDuelEvent | null {
  if (ctx) {
    switch (message.type) {
      case OcgMessageType.BATTLE:
        ctx.battle = true;
        break;
      case OcgMessageType.CHAIN_SOLVING: {
        const link = chain[message.chain_size - 1];
        ctx.resolving = link ? { index: message.chain_size, code: link.code, seat: link.seat, type: cards.get(link.code)?.type ?? 0 } : null;
        break;
      }
      case OcgMessageType.CHAIN_SOLVED:
      case OcgMessageType.CHAIN_END:
        ctx.resolving = null;
        clearSummonMaterials(ctx);
        if (message.type === OcgMessageType.CHAIN_END) ctx.chainTargetNotes.length = 0;
        break;
      case OcgMessageType.DAMAGE_STEP_END:
      case OcgMessageType.NEW_PHASE:
      case OcgMessageType.CHAINING:
      case OcgMessageType.ATTACK:
        ctx.battle = false;
        break;
      default:
        break;
    }
    switch (message.type) {
      case OcgMessageType.SUMMONING:
        ctx.pendulumSummon = false;
        break;
      case OcgMessageType.SPSUMMONED:
      case OcgMessageType.NEW_PHASE:
      case OcgMessageType.NEW_TURN:
        ctx.pendulumSummon = false;
        clearSummonMaterials(ctx);
        break;
      default:
        break;
    }
  }
  switch (message.type) {
    case OcgMessageType.SUMMONING:
    case OcgMessageType.SPSUMMONING:
    case OcgMessageType.FLIPSUMMONING: {
      const verb =
        message.type === OcgMessageType.SUMMONING
          ? "Normal Summons"
          : message.type === OcgMessageType.SPSUMMONING
            ? "Special Summons"
            : "Flip Summons";
      const info = cards.get(message.code);
      const format = ctx?.format;
      const who = playerLabel(format, message.controller);
      const text = `${who} ${verb} ${info?.name ?? `Card ${message.code}`}`;
      const hidden = (message.position & OcgPosition.FACEDOWN) !== 0;
      let summonKind: DuelSummonKind =
        message.type === OcgMessageType.SUMMONING ? "normal" : message.type === OcgMessageType.SPSUMMONING ? "special" : "flip";
      if (summonKind === "normal") {
        if (ctx?.summonTribute) summonKind = "tribute";
      } else if (summonKind === "special" && ctx) {
        summonKind = specialSummonKind(ctx, message, info?.type ?? 0);
      }
      // One procedure can announce multiple Special Summons before a single SPSUMMONED.
      if (ctx && message.type !== OcgMessageType.SPSUMMONING) clearSummonMaterials(ctx);
      return {
        id, kind: "summon", seat: seatOf(format, message.controller), card: info, text,
        publicText: hidden ? `${who} ${verb} a face-down monster` : text,
        revealCardTo: hidden ? audienceOf(format, message.controller) : "all",
        zone: zoneRefOf(format, message),
        summonKind,
      };
    }
    case OcgMessageType.SET: {
      if (ctx && message.location === OcgLocation.MZONE) clearSummonMaterials(ctx);
      const info = cards.get(message.code);
      const format = ctx?.format;
      const who = playerLabel(format, message.controller);
      const publicText = `${who} Sets a card`;
      const text = info ? `${who} Sets ${info.name}` : publicText;
      return { id, kind: "set", seat: seatOf(format, message.controller), card: info, text, publicText, revealCardTo: audienceOf(format, message.controller), zone: zoneRefOf(format, message) };
    }
    case OcgMessageType.POS_CHANGE: {
      const info = cards.get(message.code);
      const from = message.prev_position as number;
      const to = message.position as number;
      const wasUp = !isFacedownPosition(from);
      const isUp = !isFacedownPosition(to);
      const name = info?.name ?? `Card ${message.code}`;
      const flip = !wasUp && isUp;
      const text = flip
        ? `${name} was flipped face-up`
        : isUp || wasUp
          ? `${name} changed to ${to & OcgPosition.DEFENSE ? "Defense" : "Attack"} Position`
          : `${name} changed position`;
      const event: StoredDuelEvent = {
        id,
        kind: "position",
        seat: seatOf(ctx?.format, message.controller),
        card: info,
        text,
        publicText: wasUp || isUp ? text : "A face-down card changed position",
        // Same rule as moves: the identity is shown when the card is face-up before or after.
        revealCardTo: wasUp || isUp ? "all" : audienceOf(ctx?.format, message.controller),
        zone: zoneRefOf(ctx?.format, message),
        fromPosition: from,
        toPosition: to,
      };
      if (flip) event.flip = true;
      return event;
    }
    case OcgMessageType.CHAINING: {
      const info = cards.get(message.code);
      const description = fillPlaceholders(cards.resolveLabel(message.description), [info?.name, locationLabel(message.location, message.sequence)]) || undefined;
      chain.length = message.chain_size;
      chain[message.chain_size - 1] = {
        index: message.chain_size,
        seat: message.controller,
        code: message.code,
        description,
        zone: zoneOf(message),
        targets: [],
      };
      const text = `${info?.name ?? `Card ${message.code}`} is activating`;
      return {
        id,
        kind: "activate",
        seat: seatOf(ctx?.format, message.controller),
        card: info,
        chainIndex: message.chain_size,
        text,
        publicText: text,
        description,
        revealCardTo: "all",
        zone: zoneRefOf(ctx?.format, message),
      };
    }
    case OcgMessageType.TOSS_COIN: {
      const source = ctx?.resolving;
      const text = `Coin toss: ${message.results.map((value) => value ? "Heads" : "Tails").join(", ")}`;
      return {
        id, kind: "toss", seat: seatOf(ctx?.format, message.player),
        text, publicText: text, revealCardTo: "all",
        toss: { type: "coin", results: message.results.map((value) => value ? "heads" : "tails") },
        ...(source ? { card: cards.get(source.code), sourceCode: source.code, chainIndex: source.index } : {}),
      };
    }
    case OcgMessageType.CHAIN_SOLVING:
      return chainLinkEvent(id, "chain-resolving", message.chain_size, chain, cards, "is resolving", ctx?.format);
    case OcgMessageType.CHAIN_SOLVED:
      return chainLinkEvent(id, "chain-resolved", message.chain_size, chain, cards, "resolved", ctx?.format);
    case OcgMessageType.CHAIN_NEGATED:
      return chainLinkEvent(id, "chain-negated", message.chain_size, chain, cards, "was negated", ctx?.format);
    case OcgMessageType.CHAIN_DISABLED:
      return chainLinkEvent(id, "chain-negated", message.chain_size, chain, cards, "was disabled", ctx?.format);
    case OcgMessageType.CHAIN_END:
      chain.length = 0;
      return { id, kind: "chain-end", text: "Chain ended", publicText: "Chain ended", revealCardTo: "all" };
    case OcgMessageType.ATTACK: {
      const format = ctx?.format;
      const seat = message.card.controller;
      const who = playerLabel(format, seat);
      const text = message.target
        ? `${who} declares an attack`
        : `${who} declares a direct attack`;
      const event: StoredDuelEvent = { id, kind: "attack", seat: seatOf(format, seat), text, publicText: text, revealCardTo: "all", zone: zoneRefOf(format, message.card) };
      const target = message.target ? zoneRefOf(format, message.target) : undefined;
      if (target) event.target = target;
      return event;
    }
    // The attack was negated (Negate Attack, Magic Cylinder, ...): the declared attack is over, with no battle.
    case OcgMessageType.ATTACK_DISABLED:
      return { id, kind: "attack-negated", text: "Attack negated", publicText: "Attack negated", revealCardTo: "all" };
    case OcgMessageType.DAMAGE_STEP_END:
      return { id, kind: "battle-end", text: "Damage Step ended", publicText: "Damage Step ended", revealCardTo: "all" };
    case OcgMessageType.BATTLE: {
      const stats = (card: NonNullable<typeof message.card>) => ({
        attack: card.attack, defense: card.defense, position: card.position as number,
      });
      const text = "Damage calculation";
      const event: StoredDuelEvent = {
        id, kind: "battle", seat: message.card.controller, text, publicText: text,
        revealCardTo: "all", zone: zoneOf(message.card), battle: { attacker: stats(message.card) },
      };
      // The stock wrapper parses the direct-attack sentinel as a zero-location card.
      if (message.target?.location === OcgLocation.MZONE) {
        event.target = zoneOf(message.target);
        event.battle!.target = stats(message.target);
      }
      return event;
    }
    case OcgMessageType.DAMAGE: {
      if (message.amount <= 0) return null;
      const text = `Player ${message.player + 1} takes ${message.amount} damage`;
      return {
        id, kind: "damage", seat: message.player, text, publicText: text, revealCardTo: "all",
        amount: message.amount, cause: ctx?.battle ? "battle" : "effect",
      };
    }
    case OcgMessageType.RECOVER: {
      if (message.amount <= 0) return null;
      const text = `Player ${message.player + 1} gains ${message.amount} LP`;
      return { id, kind: "recover", seat: message.player, text, publicText: text, revealCardTo: "all", amount: message.amount };
    }
    case OcgMessageType.PAY_LPCOST: {
      if (message.amount <= 0) return null;
      const text = `Player ${message.player + 1} pays ${message.amount} LP`;
      return {
        id, kind: "damage", seat: message.player, text, publicText: text, revealCardTo: "all",
        amount: message.amount, cause: "cost",
      };
    }
    case OcgMessageType.MOVE: {
      if (!ctx) return null;
      if (!isFieldLocation(message.from.location) || isFieldLocation(message.to.location)) return null;
      if ((message.to.location as number) === LOCATION_DECKMASTER) return null;
      const from = {
        controller: message.from.controller,
        location: message.from.location,
        sequence: message.from.sequence,
        position: message.from.position,
      };
      const detail = takeDestroyNote(ctx, cards, from);
      if (detail) return destroyEvent(id, message.card, from, cards, detail, ctx.format);
      ctx.pendingMoves.push({ code: message.card, from, resolving: ctx.resolving });
      return null;
    }
    case OcgMessageType.NEW_PHASE: {
      const text = announcedPhaseTitle(message.phase);
      if (!text) return null;
      return { id, kind: "phase", text, publicText: text, revealCardTo: "all" };
    }
    case OcgMessageType.EQUIP: {
      // The message carries board positions only, which are public. The cards are read from the board
      // (DuelCard.equippedTo), so the event names none and nothing hidden can leak through it.
      const text = `Player ${message.card.controller + 1} equips a card`;
      return {
        id,
        kind: "equip",
        seat: message.card.controller,
        text,
        publicText: text,
        revealCardTo: "all",
        zone: zoneOf(message.card),
        target: zoneOf(message.target),
      };
    }
    default:
      return null;
  }
}

function cardAt(seats: DuelSeatView[], controller: number, location: number, sequence: number): DuelCard | null | undefined {
  const seat = seats[controller];
  if (!seat) return undefined;
  if (location === OcgLocation.MZONE) return seat.monsters[sequence] ?? null;
  if (location === OcgLocation.SZONE) return seat.spells[sequence] ?? null;
  if (location === OcgLocation.HAND) return seat.hand.find((card) => card.sequence === sequence) ?? null;
  if (location === OcgLocation.GRAVE) return seat.graveyard.find((card) => card.sequence === sequence) ?? null;
  if (location === OcgLocation.REMOVED) return seat.banished.find((card) => card.sequence === sequence) ?? null;
  if (location === OcgLocation.EXTRA) return seat.extra.find((card) => card.sequence === sequence) ?? null;
  if (location === LOCATION_DECKMASTER) {
    const master = seat.deckMaster?.card;
    if (!master) return null;
    return {
      controller,
      location,
      sequence: 0,
      position: OcgPosition.FACEUP_ATTACK,
      code: master.code,
      name: master.name,
    };
  }
  return undefined;
}

/** Adds the real code of each card in the list that the viewer cannot see. */
function collectHiddenCodes(into: Set<number>, queries: Array<Partial<OcgCardQueryInfo> | null>, projected: Array<DuelCard | null>): void {
  queries.forEach((query, sequence) => {
    if (query?.code && projected[sequence] && projected[sequence]!.code == null) into.add(query.code);
  });
}

function promptOptionVisible(option: DuelPromptOption, viewer: number, seats: DuelSeatView[], reveals: RevealMap, partnerSeat: number | null): boolean {
  if (option.controller == null || option.location == null || option.sequence == null) return true;
  const revealed = slotRevealed(reveals, viewer, option.controller, option.location, option.sequence, option.card?.code);
  if (option.location === OcgLocation.DECK || option.location === 0) {
    return revealed || viewer === option.controller;
  }
  const fieldCard = cardAt(seats, option.controller, option.location, option.sequence);
  if (fieldCard) return fieldCard.code != null;
  return cardIsVisible({
    viewer,
    controller: option.controller,
    location: option.location,
    position: OcgPosition.FACEDOWN,
    revealed,
    partner: partnerSeat === option.controller,
  });
}

function redactPromptOption(option: DuelPromptOption, fieldCard: DuelCard | null | undefined): DuelPromptOption {
  const redacted: DuelPromptOption = {
    id: option.id,
    label: fieldCard && isFacedownPosition(fieldCard.position) ? "Face-down card" : "Unknown card",
  };
  if (option.controller != null) redacted.controller = option.controller;
  if (option.location != null) redacted.location = option.location;
  if (option.sequence != null) redacted.sequence = option.sequence;
  if (option.host) redacted.host = { controller: option.host.controller, location: option.host.location, sequence: option.host.sequence };
  if (option.values) redacted.values = option.values;
  if (option.max != null) redacted.max = option.max;
  if (option.selected != null) redacted.selected = option.selected;
  return redacted;
}

function projectPrompt(
  prompt: DuelPrompt | null,
  viewer: number | null,
  promptSeat: number | null,
  seats: DuelSeatView[],
  reveals: RevealMap,
  hiddenFieldCodes: ReadonlySet<number>,
  partnerSeat: number | null = null,
): DuelPrompt | null {
  if (!prompt || viewer == null || viewer !== promptSeat) return null;
  const projected: DuelPrompt = {
    ...prompt,
    options: prompt.options.map((option) => {
      // A zone choice names a place (label from zoneLabel), never a card, so it hides nothing.
      if (prompt.kind === "places") return option;
      if (option.location === OcgLocation.OVERLAY && option.host) {
        // An Xyz material shows while its Xyz monster does, and says which Xyz it is under.
        const hostCard = cardAt(seats, option.host.controller, option.host.location, option.host.sequence);
        // A hidden Xyz is no reason to call its material face-down: it has no field card of its own.
        if (hostCard?.code == null) return redactPromptOption(option, null);
        return { ...option, host: { ...option.host, code: hostCard.code, ...(hostCard.name ? { name: hostCard.name } : null) } };
      }
      const card = cardAt(seats, option.controller ?? -1, option.location ?? -1, option.sequence ?? -1);
      if (promptOptionVisible(option, viewer, seats, reveals, partnerSeat)) {
        return card?.level != null ? { ...option, currentLevel: card.level } : option;
      }
      return redactPromptOption(option, card);
    }),
  };
  // A position prompt carries only a card code, no zone. When a card with that code is face-down on
  // the field and this seat cannot see it, the prompt may be about that card, so it names nothing.
  // A card that moves from this seat's own hand, Deck or Extra Deck keeps its name.
  if (prompt.context?.type === "position") {
    const code = prompt.options.find((option) => option.card)?.card?.code;
    if (code != null && hiddenFieldCodes.has(code)) {
      projected.title = "Select a battle position";
      delete projected.description;
      delete projected.source;
      projected.options = prompt.options.map((option) => {
        const { card: _card, cardText: _cardText, ...rest } = option;
        return rest;
      });
    }
  }
  // A located source card must be visible to the answering seat, or the prompt names nothing.
  if (prompt.source?.zone) {
    const { controller, location, sequence } = prompt.source.zone;
    const revealed = slotRevealed(reveals, viewer, controller, location, sequence, prompt.source.code);
    const board = cardAt(seats, controller, location, sequence);
    const visible = board
      ? board.code != null
      : revealed || viewer === controller || cardIsVisible({ viewer, controller, location, position: OcgPosition.FACEDOWN, revealed, partner: partnerSeat === controller });
    if (!visible) delete projected.source;
  }
  return projected;
}

export function projectView(args: {
  lib: OcgCoreSync;
  /** Capabilities of the binary loaded by this duel. Missing metadata keeps separate EMZ. */
  coreCapabilities?: CoreCapabilities;
  handle: OcgDuelHandle;
  cards: CardDatabase;
  viewer: number | null;
  revision: number;
  turn: number;
  turnSeat: number;
  phase: string;
  battleStep?: DuelBattleStep | null;
  /** LP per seat. In Tag both partners hold the team LP. */
  lp: readonly number[];
  prompt: DuelPrompt | null;
  promptSeat: number | null;
  log: LogEntry[];
  events: StoredDuelEvent[];
  /** Live chain memory, including targets, for every seat layout. */
  chain?: readonly StoredChainLink[];
  result: DuelEngineView["result"];
  reveals: RevealMap;
  mode: DuelMode;
  domainState?: DomainSeatState[];
  /** Hand animation identities (the engine query still decides what the hand holds and in which order). */
  handIdentities?: HandIdentities;
  /** Seat and team layout. Default `1v1`. More than two seats: the view fills `format`, `team` and `eliminated`. */
  format?: DuelFormat;
  /** Seats that lost while the duel goes on (FFA seat, or every seat of a Tag team). */
  eliminated?: ReadonlySet<number>;
  /** Seats whose elimination is requested but not applied yet: the core reports the loss after the open prompt is answered. */
  leaving?: ReadonlySet<number>;
}): DuelEngineView {
  const format = args.format ?? "1v1";
  const seatCount = seatCountFor(format);
  const multi = seatCount > 2;
  // QueryField output grows with the duelist count and the wrapper misreads it above two: read per seat instead.
  const field = multi ? null : args.lib.duelQueryField(args.handle);
  const partnerSeat = args.viewer == null ? null : partnerSeatOf(format, args.viewer);
  const hiddenFieldCodes = new Set<number>();
  const seats: DuelSeatView[] = Array.from({ length: seatCount }, (_, seat) => seat).map((seat) => {
    const controller = seat;
    const partner = partnerSeat === seat;
    if (multi && args.eliminated?.has(seat)) {
      return emptySeatView(seat, format, args.lp[seat] ?? 0, args.domainState?.[seat], args.cards, args.mode);
    }
    const player = field ? field.players[controller as 0 | 1] : null;
    const monsterQueries = queryLocation(args.lib, args.handle, controller, OcgLocation.MZONE);
    const monsters = monsterQueries.map((query, sequence) => {
      const overlays = overlayMaterials(controller, args.cards, query?.overlayCards);
      const card = queryToCard(controller, OcgLocation.MZONE, sequence, query, args.cards, overlays);
      if (!card) return null;
      const visible = cardIsVisible({
        viewer: args.viewer,
        controller,
        location: OcgLocation.MZONE,
        position: card.position,
        isPublic: query?.isPublic,
        isHidden: query?.isHidden,
        revealed: slotRevealed(args.reveals, args.viewer, controller, OcgLocation.MZONE, sequence, query?.code),
        partner,
      });
      const projected = redactCard(card, visible);
      if (!visible) delete projected.materials;
      else if (projected.materials) {
        projected.materials = projected.materials.map((material) => redactCard(material, visible));
      }
      return projected;
    });
    const spellQueries = queryLocation(args.lib, args.handle, controller, OcgLocation.SZONE);
    const spells = projectList(args.viewer, controller, OcgLocation.SZONE, spellQueries, args.cards, args.reveals, partner);
    collectHiddenCodes(hiddenFieldCodes, monsterQueries, monsters);
    collectHiddenCodes(hiddenFieldCodes, spellQueries, spells);
    const handQueries = queryLocation(args.lib, args.handle, controller, OcgLocation.HAND);
    // EFFECT_PUBLIC is shared knowledge even in an owner query. Temporary, viewer-scoped
    // confirmations are intentionally excluded: the engine forgets those on SHUFFLE_HAND.
    args.handIdentities?.syncPublic(seat, handQueries);
    const engineHand = compact(projectList(args.viewer, controller, OcgLocation.HAND, handQueries, args.cards, args.reveals, partner));
    // The query alone determines membership, order and engine coordinates. IDs only keep DOM
    // nodes and animation destinations attached while the core inserts, removes or shuffles.
    // A Tag partner sees the hand like its owner, so it follows the owner identities.
    const hand = engineHand.map((card) => {
      const handId = args.handIdentities?.at(seat, args.viewer === seat || partner, card.sequence);
      return handId ? { ...card, handId } : card;
    });
    const graveyard = compact(projectList(args.viewer, controller, OcgLocation.GRAVE, queryLocation(args.lib, args.handle, controller, OcgLocation.GRAVE), args.cards, args.reveals, partner));
    const banished = compact(projectList(args.viewer, controller, OcgLocation.REMOVED, queryLocation(args.lib, args.handle, controller, OcgLocation.REMOVED), args.cards, args.reveals, partner));
    const extraQueries = queryLocation(args.lib, args.handle, controller, OcgLocation.EXTRA);
    const extra = compact(projectList(args.viewer, controller, OcgLocation.EXTRA, extraQueries, args.cards, args.reveals, partner)).filter((card) => {
      if (args.viewer === controller) return true;
      return card.code != null;
    });
    const domain = args.domainState?.[seat];
    const view: DuelSeatView = {
      seat,
      lp: args.lp[seat] ?? 0,
      hand,
      deckCount: player ? player.deck_size : args.lib.duelQueryCount(args.handle, controller, OcgLocation.DECK),
      extraCount: player ? player.extra_size : args.lib.duelQueryCount(args.handle, controller, OcgLocation.EXTRA),
      extra,
      monsters: monsters.length === 7 ? monsters : [...monsters, ...Array.from({ length: Math.max(0, 7 - monsters.length) }, () => null)],
      spells: spells.length === 8 ? spells : [...spells, ...Array.from({ length: Math.max(0, 8 - spells.length) }, () => null)],
      graveyard,
      banished,
    };
    if (args.mode === "domain" && domain) {
      const info = args.cards.get(domain.code);
      if (info) view.deckMaster = { card: info, inZone: domain.inZone, returns: domain.returns, nextCost: domain.nextCost };
    }
    if (multi) {
      const sharedExtra = format === "tag" ? args.coreCapabilities?.tagSharedExtraZones : args.coreCapabilities?.ffa4SharedExtraZones;
      view.sharedExtraWith = sharedExtra ? sharedExtraSeatOf(format, seat, args.eliminated) : null;
      view.team = teamOfSeat(format, seat);
      view.eliminated = false;
      if (args.leaving?.has(seat)) view.pendingElimination = true;
    }
    return view;
  });

  const chain = field ? field.chain.map((link, index) => {
    const info = args.cards.get(link.code);
    const description = fillPlaceholders(args.cards.resolveLabel(link.description), [info?.name, locationLabel(link.location, link.sequence)]) || undefined;
    return {
      index: index + 1,
      seat: link.controller,
      code: link.code,
      name: info?.name,
      description,
      text: info?.description || undefined,
      cardType: info?.type,
      zone: args.chain?.[index]?.zone ? zoneOf(args.chain[index].zone) : zoneOf(link),
      targets: args.chain?.[index]?.targets.map(zoneOf) ?? [],
      ...(args.chain?.[index]?.chosenOptions ? { chosenOptions: args.chain[index].chosenOptions!.map((option) => ({ ...option })) } : {}),
    };
  }) : (args.chain ?? []).map((link) => ({
    index: link.index,
    seat: link.seat,
    code: link.code,
    name: args.cards.get(link.code)?.name,
    description: link.description,
    text: args.cards.get(link.code)?.description || undefined,
    cardType: args.cards.get(link.code)?.type,
    zone: link.zone ? zoneOf(link.zone) : undefined,
    targets: link.targets.map(zoneOf),
    ...(link.chosenOptions ? { chosenOptions: link.chosenOptions.map((option) => ({ ...option })) } : {}),
  }));

  const view: DuelEngineView = {
    revision: args.revision,
    turn: args.turn,
    turnSeat: args.turnSeat,
    phase: args.phase,
    battleStep: args.battleStep ?? null,
    seats,
    prompt: projectPrompt(args.prompt, args.viewer, args.promptSeat, seats, args.reveals, hiddenFieldCodes, partnerSeat),
    prioritySeat: args.prompt && !args.result ? args.promptSeat : null,
    chain,
    events: args.events.map((event) => {
      const projected = projectStoredEvent(event, args.viewer);
      if (event.kind === "move" && event.zone?.location === OcgLocation.HAND && args.handIdentities) {
        const seat = event.zone.controller;
        const entry = args.handIdentities.arrival(seat, args.viewer === seat || partnerSeat === seat, event.id);
        const visible = entry && seats[seat]?.hand[entry.sequence];
        // Viewer-scoped confirmations may reveal a different card on an anonymous sleeve.
        // Retire that audience's correlation without changing spectator/public sleeve history.
        const mismatched = visible?.code != null && projected.card?.code != null && visible.code !== projected.card.code;
        // A departed arrival gets an unresolvable id so its flight cannot hide a replacement card.
        projected.handId = entry && !mismatched ? entry.id : `departed-${event.id}`;
        if (args.handIdentities.shuffledSinceArrival(seat, event.id)) projected.handShuffled = true;
        // Keep the original engine message coordinates in history. Flights resolve this ID in the
        // current query-ordered hand, rather than rewriting past draws/moves after later compaction.
      }
      return projected;
    }),
    log: args.log
      .filter((entry) => entry.audience === "all" || entry.audience === args.viewer)
      .map(({ id, text, eventId }) => ({ id, text, ...(eventId != null ? { eventId } : {}) })),
    result: args.result,
  };
  if (multi) view.format = format;
  return view;
}

/** A seat that lost: its cards left the game. */
function emptySeatView(
  seat: number,
  format: DuelFormat,
  lp: number,
  domain: DomainSeatState | undefined,
  cards: CardDatabase,
  mode: DuelMode,
): DuelSeatView {
  const view: DuelSeatView = {
    seat,
    sharedExtraWith: null,
    lp,
    hand: [],
    deckCount: 0,
    extraCount: 0,
    extra: [],
    monsters: Array.from({ length: 7 }, () => null),
    spells: Array.from({ length: 8 }, () => null),
    graveyard: [],
    banished: [],
    team: teamOfSeat(format, seat),
    eliminated: true,
  };
  if (mode === "domain" && domain) {
    const info = cards.get(domain.code);
    if (info) view.deckMaster = { card: info, inZone: false, returns: domain.returns, nextCost: domain.nextCost };
  }
  return view;
}
