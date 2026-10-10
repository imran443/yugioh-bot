import assert from "node:assert/strict";
import createCore, {
  OcgDuelMode, OcgLocation, OcgMessageType, OcgPosition, OcgProcessResult,
  OcgResponseType, SelectIdleCMDAction, type OcgMessage, type OcgResponse,
} from "ocgcore-wasm";
import { loadCardDatabase } from "../../src/cards.js";
import { engineDataDirectory } from "../engine-data-dir.js";

/** Stock scripts: Dianaira clears Reborn at CL1; Shift retargets Book of Moon from CL2. */
export async function retargetMessages(scenario: "dianaira" | "shift" = "dianaira", noteScript?: string): Promise<{ messages: OcgMessage[]; notes: string[]; targetNotes: string[] }> {
  const cards = loadCardDatabase(engineDataDirectory);
  const core = await createCore({ sync: true });
  const errors: string[] = [];
  const notes: string[] = [];
  const targetNotes: string[] = [];
  const handle = core.createDuel({
    flags: OcgDuelMode.MODE_MR5, seed: [1n, 2n, 3n, 4n],
    team1: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 0 },
    team2: { startingLP: 8000, startingDrawCount: 0, drawCountPerTurn: 0 },
    cardReader: cards.cardData, scriptReader: cards.readScript,
    errorHandler: (_type, text) => {
      if (text.startsWith("YGD:CHAIN_TARGET:")) notes.push(text);
      else if (text.startsWith("YGD:TARGET_CARD:")) targetNotes.push(text);
      else errors.push(text);
    },
  });
  assert(handle);
  try {
    for (const name of ["constant.lua", "utility.lua"]) {
      const script = cards.readScript(name);
      assert(script);
      assert(core.loadScript(handle, name, script));
    }
    if (noteScript) assert(core.loadScript(handle, "chain-target-notes.lua", noteScript));
    const add = (controller: 0 | 1, code: number, location: OcgLocation, sequence = 0,
      position: OcgPosition = OcgPosition.FACEUP_ATTACK) => core.duelNewCard(handle,
      { team: controller, duelist: 0, controller, code, location, sequence, position });
    for (const controller of [0, 1] as const) add(controller, 46986414, OcgLocation.DECK, 0, OcgPosition.FACEDOWN_DEFENSE);
    const activationCode = scenario === "dianaira" ? 83764718 : 14087893;
    const responseCode = scenario === "dianaira" ? 5318639 : 59560625;
    add(0, activationCode, OcgLocation.HAND);
    if (scenario === "dianaira") {
      add(0, 46986414, OcgLocation.HAND); // discard for the replacement effect
      add(0, 46986414, OcgLocation.GRAVE);
      add(1, 53199020, OcgLocation.MZONE);
      add(1, 44095762, OcgLocation.SZONE, 1, OcgPosition.FACEDOWN_DEFENSE);
    } else {
      add(1, 46986414, OcgLocation.MZONE);
      add(1, 89631139, OcgLocation.MZONE, 1);
    }
    add(1, responseCode, OcgLocation.SZONE, 0, OcgPosition.FACEDOWN_DEFENSE);
    core.startDuel(handle);
    const messages: OcgMessage[] = [];
    let chained = false;
    for (let step = 0; step < 100; step++) {
      const status = core.duelProcess(handle);
      const batch = core.duelGetMessage(handle);
      messages.push(...batch);
      if (batch.some((message) => message.type === OcgMessageType.CHAIN_END)) {
        assert.deepEqual(errors, []);
        return { messages, notes, targetNotes };
      }
      assert.notEqual(status, OcgProcessResult.END, "duel ended before the retargeting chain");
      if (status !== OcgProcessResult.WAITING) continue;
      const prompt = batch.at(-1)!;
      let response: OcgResponse;
      switch (prompt.type) {
        case OcgMessageType.SELECT_IDLECMD: {
          const index = prompt.activates.findIndex((card) => card.code === activationCode);
          assert(index >= 0, "the targeting spell must be activatable");
          response = { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.SELECT_ACTIVATE, index };
          break;
        }
        case OcgMessageType.SELECT_CHAIN: {
          const activationStarted = messages.some((message) => message.type === OcgMessageType.CHAINING && message.code === activationCode);
          const index = activationStarted && !chained && prompt.player === 1 ? prompt.selects.findIndex((card) => card.code === responseCode) : -1;
          if (index >= 0) chained = true;
          response = { type: OcgResponseType.SELECT_CHAIN, index: index >= 0 ? index : null };
          break;
        }
        case OcgMessageType.SELECT_CARD: {
          const index = prompt.selects.findIndex((card) => scenario === "dianaira" ? card.code === 44095762
            : card.location === OcgLocation.MZONE && card.sequence === (chained ? 1 : 0));
          response = { type: OcgResponseType.SELECT_CARD, indicies: [index >= 0 ? index : 0] };
          break;
        }
        case OcgMessageType.SELECT_PLACE:
          response = { type: OcgResponseType.SELECT_PLACE, places: [{ player: 0, location: OcgLocation.SZONE, sequence: 0 }] };
          break;
        case OcgMessageType.SELECT_YESNO:
          response = { type: OcgResponseType.SELECT_YESNO, yes: false };
          break;
        default:
          throw new Error(`Unexpected retargeting prompt: ${JSON.stringify(prompt, (_key, value) => typeof value === "bigint" ? String(value) : value)}`);
      }
      core.duelSetResponse(handle, response);
    }
    throw new Error("Retargeting scenario exceeded its step limit");
  } finally {
    core.destroyDuel(handle);
  }
}
