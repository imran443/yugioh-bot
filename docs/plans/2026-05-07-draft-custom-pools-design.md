# Draft Custom Pools Design

## Goal

Fix web draft starts that fail with `Draft pool is empty`, then add server-wide reusable custom draft pools that can be imported from card ID text files.

## Current Behavior

The Discord `/draft start` path syncs selected set cards into `card_catalog` before calling `drafts.start()`. The web draft start API calls `drafts.start()` directly. If the chosen set has not already been cached, `catalogCardIdsForDraft()` returns no cards and `openWave()` throws `Draft pool is empty`.

Draft templates already store server-wide draft configuration in `draft_templates`, including selected sets and include/exclude names. Web draft creation and management currently only expose set selection.

## Decision

Use the existing server-wide `draft_templates` model and extend `DraftConfig` with `customCardIds?: number[]`.

This keeps saved custom pools aligned with existing template behavior. A draft may use selected sets, a custom pool, or both. Excludes and Extra Deck filtering still apply.

## Data Model

Add `customCardIds?: number[]` to `DraftConfig`. No schema change is needed because draft config and template config are already stored as JSON.

Custom pool import accepts card IDs from text using newline, comma, or whitespace separators. Invalid tokens are rejected. Duplicate IDs are deduped while preserving first occurrence.

## API Behavior

The web draft start API will call `createCardCatalogService(db).syncDraftPool(...)` before `drafts.start()`, matching Discord behavior.

The card catalog sync input will include `customCardIds`. Existing selected-set and include-name sync remains unchanged. Custom card IDs are resolved from cached `card_catalog` rows for now; if IDs are missing, the draft start response should report that the custom pool contains card IDs not found in the catalog.

The draft service will include `customCardIds` when building the playable catalog ID list, in addition to selected sets and include names.

## UI Behavior

Create/edit draft keeps set selection and adds a Custom Pool section. Users can paste/import text from files like `The Lost Millennium.txt` containing card IDs.

Users can save the current draft configuration as a server-wide template and load an existing template. The template reuses existing `draft_templates` storage and includes selected sets plus `customCardIds`.

## Error Handling

If a web start has selected sets, sync errors are surfaced as draft start errors instead of falling through to `Draft pool is empty`.

If a custom pool has no valid card IDs, the form rejects it before save.

If custom IDs are valid numbers but absent from `card_catalog`, the server returns a clear validation error.

## Testing

Use TDD. Add focused tests for:

- Web start syncs the selected set draft pool before starting.
- `DraftConfig.customCardIds` contributes playable card IDs.
- Imported card ID text parses newline/comma/whitespace-separated IDs, rejects invalid tokens, and dedupes IDs.
- Draft templates persist and reload `customCardIds` server-wide.
