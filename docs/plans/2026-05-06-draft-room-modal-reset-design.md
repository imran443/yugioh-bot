# Draft Room Modal, Preview, and Reset Design

**Problem:** The active draft room still has three interaction bugs. The desktop preview always renders below the hovered card and can be clipped by the viewport. The card picker can remain open after timer expiry or server rotation, leaving the user able to submit a stale card and trigger a `400`. Completed short test drafts also show an `Export YDK` action that cannot succeed because the pool never reaches the `40` cards required by the exporter.

**Approach:** Keep the draft room fast and competitive by separating fast inspection from explicit confirmation. Desktop hover still shows an overlapping preview, but the preview position becomes viewport-aware so it can render above or beside the hovered card when space is tight. Card selection opens a centered modal instead of a right-side sheet, and any authoritative server update that changes the pack or ends the turn clears the open selection and preview state immediately. The picker also refuses to submit if the selected card is no longer present in `currentPack`.

**Reset Flow:** Add a single local reset command that reseeds the SQLite database and restarts the long-lived services that hold database handles. This keeps manual testing one command away without introducing a production-facing admin control.

**Export Behavior:** Keep YDK export aligned with the backend rule. Completed drafts only show an active export action when the participant has at least `40` picks; otherwise the summary explains that the draft completed successfully but is too small to export as a legal YDK.

**Testing:** Add component regressions for modal opening and stale-selection clearing on server refresh, for preventing stale pick submission after timer expiry, and for export gating on completed but undersized drafts. Extend the existing card grid coverage to assert the hover preview uses the new fixed overlapping container.
