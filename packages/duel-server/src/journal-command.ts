import { chainModeOf, type DuelAnswer } from "@yugidraft/shared/duels";
import { eliminationAtTurnEnd, eliminationCodeOf, type EngineGame } from "./engine.js";
import type { DuelGameWorker } from "./worker-client.js";

/** Dispatch in journal order. Callers check the saved revision and ordinary prompt first. */
export async function applyWorkerJournalCommand(game: DuelGameWorker, seat: number, command: { promptId: string; answer: DuelAnswer }): Promise<void> {
  const elimination = eliminationCodeOf(command.promptId);
  const mode = chainModeOf(command.promptId);
  if (mode !== null) {
    if (!game.setChainMode) throw new Error("Journal replay needs an engine that can set a chain response mode");
    await game.setChainMode(seat, mode);
  } else if (elimination !== null) {
    if (!game.eliminate) throw new Error("Journal replay needs an engine that can eliminate a duelist");
    await game.eliminate(seat, elimination, eliminationAtTurnEnd(command.promptId));
  } else {
    await game.answer(seat, command.promptId, command.answer);
  }
}

/**
 * The journal commands that answer no prompt: an elimination (`eliminate:<reason>` or retired `eliminate-eot:<reason>`) and a chain response mode change
 * (`chain-mode:<mode>`). Their promptId is a sentinel, so a replay checks only the revision for them.
 */
export function isPromptlessCommand(promptId: string): boolean {
  return eliminationCodeOf(promptId) !== null || chainModeOf(promptId) !== null;
}

/** Apply one journaled command to a game, the way a recover does. */
export function applyJournaledCommand(game: EngineGame, seat: number, command: { promptId: string; answer: DuelAnswer }): void {
  const elimination = eliminationCodeOf(command.promptId);
  const mode = chainModeOf(command.promptId);
  if (mode !== null) game.setChainMode(seat, mode);
  else if (elimination !== null) game.eliminate(seat, elimination, eliminationAtTurnEnd(command.promptId));
  else game.answer(seat, command.promptId, command.answer);
}
