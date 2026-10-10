import type { CardDatabase } from "../../src/cards.js";
import type { DuelEvent } from "@yugidraft/shared/duels";
import { fillPlaceholders } from "../../src/text.js";

export interface SmokeEffect { id: string; label: string; type?: number; parent?: string }

/** Match a contiguous bullet group only to a unique effect label at the end of its preceding text. */
export function smokeEffectCoverage(cases: Array<{ expected?: SmokeEffect[] }>, description = ""): { expected: Map<string, SmokeEffect>; warnings: string[] } {
  const expected = new Map(cases.flatMap(c => (c.expected ?? []).map(e => [e.id, e] as const)));
  const parts = description.split("●"), printed = parts.slice(1).map(text => text.split(/\r?\n/)[0]!.trim());
  const normalize = (text: string) => text.replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  const roots = [...expected.values()].filter(e => !e.parent);
  const branches = [...expected.values()].filter(e => e.parent && e.parent !== "card-text");
  const groups: Array<{ heading: string; indices: number[]; parent?: SmokeEffect }> = [];
  for (let index = 0; index < printed.length; index++) {
    const heading = index === 0 ? parts[0]!.trim() : parts[index]!.split(/\r?\n/).slice(1).join("\n").trim();
    if (index === 0 || heading) {
      const candidates = roots.filter(e => {
        const label = normalize(e.label.split("●")[0]!);
        return label && normalize(heading).endsWith(label);
      });
      groups.push({ heading, indices: [], parent: candidates.length === 1 ? candidates[0] : undefined });
    }
    groups.at(-1)!.indices.push(index);
  }
  const missing = new Set<number>(), warnings: string[] = [];
  for (const group of groups) {
    // Repeated labels/groups cannot establish which selection site the runtime keys describe.
    if (!group.parent || groups.filter(g => g.parent?.id === group.parent!.id).length !== 1) {
      warnings.push(`Cannot reliably match ${group.indices.length} printed branches to one parent effect: ${group.heading.replace(/\s+/g, " ") || "no effect heading"}`);
      continue;
    }
    const found = branches.filter(e => e.parent === group.parent!.id).length;
    for (const index of group.indices.slice(found)) missing.add(index);
  }
  // Preserve the original total lower bound for ambiguous text, including passive/threshold bullets.
  for (let index = branches.length; index < printed.length && missing.size < printed.length - branches.length; index++) missing.add(index);
  for (const index of [...missing].sort((a, b) => a - b)) {
    const id = `card-text-branch:${index}`;
    expected.set(id, { id, label: `Unobserved card-text branch ${index + 1}: ${printed[index]}`, parent: "card-text", type: 0 });
  }
  return { expected, warnings };
}

/** Printed bullets provide a lower bound when scripts expose only currently legal choices. */
export function smokeExpectedEffects(cases: Array<{ expected?: SmokeEffect[] }>, description = ""): Map<string, SmokeEffect> {
  return smokeEffectCoverage(cases, description).expected;
}

/** Observe actual registrations, including helper-created and mandatory effects, on each placed copy. */
export function smokeEffectScript(code: number, canonical = code): string {
  return `do
local register=Card.RegisterEffect
local ordinals=setmetatable({},{__mode='k'})
local originals=setmetatable({},{__mode='k'})
local resolving=0
local serial=0
local current=nil
local choices=setmetatable({},{__mode='k'})
local links={}
local selecting=false
local selectOption=Duel.SelectOption
local selectEffect=Duel.SelectEffect
local function modes(values)
  if not current then return end
  local site=current.key
  for index,desc in ipairs(values) do
    local key='mode:'..site..':'..desc
    Debug.Message('SMOKE_MODE|'..key..'|'..desc..'|'..current.key)
  end
  return site
end
local function pick(site,values,index)
  if not current or not values[index] then return end
  local selected=choices[current.effect] or {}; choices[current.effect]=selected
  table.insert(selected,'mode:'..site..':'..values[index])
end
Duel.SelectOption=function(tp,...)
  if selecting or not current then return selectOption(tp,...) end
  local values={...}; local site=modes(values)
  local selected=selectOption(tp,...); pick(site,values,selected+1); return selected
end
Duel.SelectEffect=function(tp,...)
  if not current then return selectEffect(tp,...) end
  local values={}; for _,candidate in ipairs({...}) do table.insert(values,candidate[2]) end
  local site=modes(values); selecting=true
  local selected=selectEffect(tp,...); selecting=false
  pick(site,values,selected); return selected
end
local watcher=Effect.GlobalEffect()
watcher:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS)
watcher:SetCode(EVENT_CHAIN_SOLVING)
watcher:SetOperation(function(e,tp,eg,ep,ev) resolving=ev end)
Duel.RegisterEffect(watcher,0)
local chained=Effect.GlobalEffect()
chained:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS)
chained:SetCode(EVENT_CHAINING)
chained:SetOperation(function(e,tp,eg,ep,ev,re)
  links[ev]=choices[re] or {}
  choices[re]=nil
end)
Duel.RegisterEffect(chained,0)
local ended=Effect.GlobalEffect()
ended:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS)
ended:SetCode(EVENT_CHAIN_END)
ended:SetOperation(function() serial=serial+1; choices=setmetatable({},{__mode='k'}); links={} end)
Duel.RegisterEffect(ended,0)
Card.RegisterEffect=function(c,e,...)
  if (c:GetOriginalCode()==${code} or c:GetOriginalCode()==${canonical}) and e:GetType()&0x7f0~=0 then
    local desc=e:GetDescription()
    local typ=e:GetType()&0x7f0
    local counts=ordinals[c] or {}; ordinals[c]=counts
    local base=tostring(desc)..':'..tostring(typ)
    local ordinal=counts[base] or 0; counts[base]=ordinal+1
    local key=base..':'..ordinal
    Debug.Message('SMOKE_EXPECT|'..key..'|'..desc..'|'..typ)
    local operation=e:GetOperation()
    operation=originals[operation] or operation
    -- Branches may be selected in an activation's target/cost, before its operation starts.
    local function context(fn,phase)
      if not fn then return end
      fn=originals[fn] or fn
      local wrapped=function(effect,...)
        local previous=current; current={key=key,effect=effect,phase=phase}
        local result=table.pack(fn(effect,...)); current=previous
        return table.unpack(result,1,result.n)
      end
      originals[wrapped]=fn; return wrapped
    end
    if e:GetTarget() then e:SetTarget(context(e:GetTarget(),'target')) end
    if e:GetCost() then e:SetCost(context(e:GetCost(),'cost')) end
    local wrapper=function(effect,...)
      local related=c:IsRelateToEffect(effect) or c:IsReason(REASON_COST)
      local index=resolving
      choices[effect]=links[index] or {}
      local previous=current; current={key=key,effect=effect,phase='operation'}
      if operation then operation(effect,...) end
      current=previous
      Debug.Message('SMOKE_DONE|'..serial..'|'..index..'|'..key..'|'..(related and '1' or '0')..'|'..effect:GetHandlerPlayer()..'|'..table.concat(choices[effect] or {},','))
      choices[effect]=nil
    end
    if operation then originals[wrapper]=operation end
    e:SetOperation(wrapper)
  end
  return register(c,e,...)
end
end`;
}

/** Lua completion alone is insufficient: wait for CHAIN_SOLVED and discard negated/interrupted tries. */
export class SmokeEffectRecorder {
  readonly expected = new Map<string, SmokeEffect>();
  private done: Array<{ serial: number; index: number; key: string; related: boolean; seat: number; modes: string[] }> = [];
  private serial = 0;
  private negated = new Set<number>();
  private eventId = 0;
  constructor(private readonly code: number, private readonly cards: CardDatabase) {}
  debug(text: string): void {
    const effect = readSmokeEffect(text, this.cards);
    if (effect) this.expected.set(effect.id, effect);
    const match = /^SMOKE_DONE\|(\d+)\|(\d+)\|([^|]+)\|([01])\|(\d+)\|(.*)$/.exec(text);
    if (match) this.done.push({ serial: Number(match[1]), index: Number(match[2]), key: match[3]!, related: match[4] === "1", seat: Number(match[5]), modes: match[6]!.split(",").filter(Boolean) });
  }
  observe(events: DuelEvent[], resolved: (effect: SmokeEffect, completed: boolean, choices?: DuelEvent["chosenOptions"]) => void): void {
    for (const event of events) {
      if (event.id <= this.eventId) continue;
      this.eventId = event.id;
      if (event.kind === "chain-negated" && event.chainIndex != null) this.negated.add(event.chainIndex);
      if (event.kind === "chain-resolved" && event.card?.code === this.code && event.seat === 0) {
        const index = this.done.findIndex(d => d.serial === this.serial && d.index === event.chainIndex && d.seat === event.seat);
        if (index >= 0) {
          const [done] = this.done.splice(index, 1);
          const effect = this.expected.get(done!.key);
          const completed = done!.related && !this.negated.has(event.chainIndex!);
          if (effect) resolved(effect, completed, event.chosenOptions);
          if (completed) for (const id of done!.modes) {
            const mode = this.expected.get(id);
            if (mode && mode.parent === done!.key) resolved(mode, true);
          }
        }
      }
      if (event.kind === "chain-end") { this.negated.clear(); this.serial++; this.done = this.done.filter(d => d.serial >= this.serial); }
    }
  }
}

export function readSmokeEffect(text: string, cards: CardDatabase): SmokeEffect | undefined {
  const mode = /^SMOKE_MODE\|([^|]+)\|(\d+)\|([^|]+)$/.exec(text);
  if (mode) return { id: mode[1]!, parent: mode[3]!, type: 0, label: fillPlaceholders(cards.resolveLabel(BigInt(mode[2]!))) || `Undescribed branch ${mode[1]}` };
  const match = /^SMOKE_EXPECT\|([^|]+)\|(\d+)\|(\d+)$/.exec(text);
  if (!match) return;
  const type = Number(match[3]);
  return { id: match[1]!, label: cards.resolveLabel(BigInt(match[2]!)) || `Undescribed effect ${match[1]}`, type };
}
