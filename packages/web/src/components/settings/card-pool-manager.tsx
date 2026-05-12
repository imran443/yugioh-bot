"use client";

import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { PoolBuilder, type PoolBuilderValue } from "@/components/cards/pool-builder";

interface PoolListItem {
  id: number;
  name: string;
  setNames: string[];
  customCardIds: number[];
}

type EditorState =
  | { mode: "closed" }
  | { mode: "new"; name: string; pool: PoolBuilderValue }
  | { mode: "edit"; id: number; name: string; pool: PoolBuilderValue };

function summaryLine(p: PoolListItem): string {
  const s = p.setNames.length;
  const c = p.customCardIds.length;
  return `${s} set${s === 1 ? "" : "s"} · ${c} custom ID${c === 1 ? "" : "s"}`;
}

export function CardPoolManager() {
  const [pools, setPools] = React.useState<PoolListItem[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [editor, setEditor] = React.useState<EditorState>({ mode: "closed" });
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [editorError, setEditorError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const res = await fetch("/api/draft-templates");
    if (res.ok) {
      const data = (await res.json()) as { templates: PoolListItem[] };
      setPools(data.templates);
    }
    setLoaded(true);
  }, []);
  React.useEffect(() => { void reload(); }, [reload]);

  const startNew = () => { setEditorError(null); setEditor({ mode: "new", name: "", pool: { setNames: [], customCardText: "" } }); };
  const startEdit = (p: PoolListItem) => {
    setEditorError(null);
    setEditor({ mode: "edit", id: p.id, name: p.name, pool: { setNames: p.setNames, customCardText: p.customCardIds.join("\n") } });
  };
  const closeEditor = () => { setEditor({ mode: "closed" }); setEditorError(null); };

  const save = async () => {
    if (editor.mode === "closed") return;
    setEditorError(null);
    const name = editor.name.trim();
    const { cardIds: customCardIds, errors } = parseCustomCardIds(editor.pool.customCardText);
    if (!name) { setEditorError("Pool name is required."); return; }
    if (errors.length > 0) { setEditorError(`Remove invalid card IDs: ${errors.slice(0, 3).join(", ")}`); return; }
    if (editor.pool.setNames.length === 0 && customCardIds.length === 0) { setEditorError("Add at least one set or one custom card ID."); return; }

    setSaving(true);
    try {
      let res: Response;
      if (editor.mode === "new") {
        res = await fetch("/api/draft-templates", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, config: { setNames: editor.pool.setNames, customCardIds } }),
        });
      } else {
        res = await fetch(`/api/draft-templates/${editor.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, setNames: editor.pool.setNames, customCardIds }),
        });
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setEditorError(body.error ?? `Save failed (${res.status}).`);
        return;
      }
      closeEditor();
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (id: number) => {
    const res = await fetch(`/api/draft-templates/${id}`, { method: "DELETE" });
    setConfirmDeleteId(null);
    if (res.ok) await reload();
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg text-text-primary">Card Pools</h2>
        <Button variant="secondary" size="sm" onClick={startNew}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New Pool
        </Button>
      </div>

      {loaded && pools.length === 0 && editor.mode === "closed" && (
        <p className="text-sm text-text-secondary">No saved pools yet. Create one to reuse it across drafts.</p>
      )}

      <ul className="flex flex-col gap-2" role="list">
        {pools.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated/40 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-text-primary">{p.name}</p>
              <p className="text-xs text-text-muted">{summaryLine(p)}</p>
            </div>
            <Button variant="ghost" size="sm" aria-label={`Edit pool ${p.name}`} onClick={() => startEdit(p)}>
              <Pencil className="h-4 w-4" />
            </Button>
            {confirmDeleteId === p.id ? (
              <span className="flex items-center gap-2 text-xs text-text-secondary">
                Delete &ldquo;{p.name}&rdquo;?
                <Button variant="danger" size="sm" onClick={() => void doDelete(p.id)}>Delete</Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
              </span>
            ) : (
              <Button variant="ghost" size="sm" aria-label={`Delete pool ${p.name}`} onClick={() => setConfirmDeleteId(p.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </li>
        ))}
      </ul>

      {editor.mode !== "closed" && (
        <div className="mt-5 space-y-4 rounded-lg border border-border bg-bg-elevated/30 p-4">
          {editorError && (
            <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">{editorError}</div>
          )}
          <div>
            <label htmlFor="pool-name" className="mb-1 block text-sm font-medium text-text-primary">
              Pool name <span className="text-accent-cta">*</span>
            </label>
            <input
              id="pool-name"
              type="text"
              value={editor.name}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
            />
          </div>
          <PoolBuilder value={editor.pool} onChange={(pool) => setEditor({ ...editor, pool })} />
          <div className="flex gap-3">
            <Button variant="primary" size="sm" onClick={() => void save()}>Save</Button>
            <Button variant="ghost" size="sm" onClick={closeEditor} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}
