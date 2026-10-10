import type { DuelAnswer, DuelCardInfo, DuelEngineView, DuelPrompt, DuelPromptOption } from "@yugidraft/shared/duels";
import { defaultAnswer } from "../../src/scripted-bot.js";

export class SmokeBot {
  readonly offered = new Set<string>();
  readonly activated = new Set<string>();
  private readonly attempts = new Map<string, number>();
  constructor(private readonly code: number, private readonly variant = 0) {}
  resolved(effect: { id: string; label: string }, completed: boolean, choices: Array<{ index?: number; text: string }> = []): void {
    if (!completed) return;
    this.activated.add(effect.id);
    for (const key of this.offered) if (!key.startsWith("mode:") && key.endsWith(`:${effect.label}`)) this.activated.add(key);
    for (const choice of choices) if (choice.index != null) this.activated.add(`mode:${this.code}:opt:${choice.index}:${choice.text}`);
  }
  private key(prompt: DuelPrompt, option: DuelPromptOption): string {
    const same = (o: DuelPromptOption) => o.card?.code === option.card?.code && o.controller === option.controller && o.location === option.location
      && o.sequence === option.sequence && (o.effectText ?? o.label) === (option.effectText ?? option.label) && o.id.split(":")[0] === option.id.split(":")[0];
    const ordinal = prompt.options.filter(same).findIndex(o => o.id === option.id);
    return `${option.card?.code ?? prompt.source?.code}:${option.controller ?? prompt.seat}:${option.location ?? prompt.source?.zone?.location}:${option.sequence ?? ""}:${option.id.split(":")[0]}:${ordinal}:${option.effectText ?? option.label}`;
  }
  answer(prompt: DuelPrompt, _view?: DuelEngineView, permittedCards?: DuelCardInfo[]): DuelAnswer {
    if (prompt.kind === "choice") {
      const effects = prompt.options.filter(o => o.id.startsWith("activate:") || (prompt.context?.type === "chain" && o.id.startsWith("card:")));
      const focus = effects.filter(o => o.card?.code === this.code);
      for (const o of focus) this.offered.add(this.key(prompt, o));
      const sorted = [...focus].sort((a, b) => (this.attempts.get(this.key(prompt, a)) ?? 0) - (this.attempts.get(this.key(prompt, b)) ?? 0));
      // Bound repeated free effects; fresh effects always come first. Loop checks still guard the engine.
      const supportWindow = prompt.context?.type !== "chain" || (_view?.chain.length ?? 0) > 0;
      const aggressive = prompt.seat === 0 || this.variant % 3 !== 1;
      const selected = sorted.find(o => (this.attempts.get(this.key(prompt, o)) ?? 0) < 3)
        ?? (supportWindow && aggressive ? effects.find(o => ([5318639, 8842266, 83968380, 60082869, 83764718].includes(o.card?.code ?? 0)
          || (prompt.seat !== 0 && o.card?.code === 85087012)) && (this.attempts.get(this.key(prompt, o)) ?? 0) < 1) : undefined);
      if (selected) {
        const key = this.key(prompt, selected);
        this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
        return { choice: selected.id };
      }
      if (prompt.options.some(o => o.id === "yes")) {
        if (prompt.source?.code === this.code) {
          const key = `yes/no:${prompt.source.zone?.location}:${prompt.title}:${prompt.description ?? ""}`;
          this.offered.add(key);
        }
        return { choice: "yes" };
      }
      if (prompt.source?.code === this.code && !prompt.context) {
        const modes = prompt.options.filter(o => o.id.startsWith("opt:"));
        if (modes.length) {
          const key = (o: DuelPromptOption) => `mode:${this.code}:${o.id}:${o.effectText ?? o.label}`;
          for (const mode of modes) this.offered.add(key(mode));
          const rotated = [...modes.slice(this.variant % modes.length), ...modes.slice(0, this.variant % modes.length)];
          const selected = rotated.sort((a, b) => (this.attempts.get(key(a)) ?? 0) - (this.attempts.get(key(b)) ?? 0))[0]!;
          this.attempts.set(key(selected), (this.attempts.get(key(selected)) ?? 0) + 1);
          return { choice: selected.id };
        }
      }
      const action = prompt.options.find(o => /^(?:summon:|flip:|attack:)/.test(o.id)
        || (o.id.startsWith("spsummon:") && o.card?.code === this.code));
      if (action) return { choice: action.id };
      const phase = ["to_bp", "to_m2", "to_ep"].map(id => prompt.options.find(o => o.id === id)).find(Boolean);
      if (phase) return { choice: phase.id };
    }
    if (prompt.kind === "cards" && prompt.seat !== 0 && [5318639, 60082869].includes(prompt.source?.code ?? 0)) {
      const target = prompt.options.find(o => o.controller === 0 && o.card?.code === this.code) ?? prompt.options.find(o => o.controller === 0);
      if (target) return { selected: [target.id] };
    }
    if (prompt.kind === "cards" && (prompt.min ?? 0) === 0 && prompt.options.length) return { selected: [prompt.options[0]!.id] };
    return defaultAnswer(prompt, { permittedCards }).answer;
  }
}
