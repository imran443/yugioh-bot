"use client";

import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
  badge?: number;
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Tournament sections"
      className="mb-6 flex gap-1 overflow-x-auto border-b border-border"
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative whitespace-nowrap px-4 py-2.5 text-sm font-medium motion-safe:transition-colors",
              selected
                ? "border-b-2 border-accent-primary text-text-primary"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {tab.label}
            {typeof tab.badge === "number" && tab.badge > 0 && (
              <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-accent-primary px-1 text-xs text-white">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
