# Dueling Engine Neos Design

## Goal

Integrate a browser-based Yu-Gi-Oh duel experience into the app by using Neos as the duel foundation, then record completed duel results back into tournament brackets and match history. The first supported format is automated official-card `1v1`; the data model should leave room for future tag duels.

## Current Context

The project is an npm workspace monorepo with `packages/web`, `packages/ws`, `packages/bot`, and `packages/shared`. The web app owns Discord OAuth, draft pages, tournament pages, and match tracking. Real-time draft updates already use Socket.IO through the `ws` package.

Neos is an open-source browser Yu-Gi-Oh client built with TypeScript, React, Redux, Babylon.js, WebAssembly, and a WebSocket protocol to a duel backend. Its developer docs describe a layered architecture: UI, reducers, services, middleware, and API/protocol code. Its protocol layer adapts raw YGOPro-style packets into protobuf objects before higher-level frontend logic consumes them.

The user accepts GPL-3.0 obligations for the integrated duel portion as long as the code remains accessible and duel results can be captured for tournament records.

## Approved Approach

Use Neos as an embedded duel subsystem rather than building a Yu-Gi-Oh rules engine from scratch. Keep the existing app as the source of truth for tournaments, users, Discord identity, match records, permissions, standings, and bracket progression. Treat Neos as the source of truth for duel execution, duel state, and duel completion outcome.

Do not couple tournament logic to Neos reducers or raw duel protocol packets. Add a bridge layer that converts Neos duel lifecycle events into app-owned result contracts.

## Product Boundary

The main app owns tournament orchestration. It creates tournament matches, assigns players, launches duel sessions, displays duel status, and records final results.

The duel subsystem owns duel execution. It presents the browser duel UI, handles player choices and engine prompts, receives backend duel messages, and determines when a duel has completed.

This boundary keeps bracket progression independent from duel UI internals and allows the duel subsystem to evolve or be replaced later.

## Package Structure

Add or reserve these package boundaries:

- `packages/duel-web`: adapted Neos browser client, including duel UI, Babylon.js field rendering, prompts, and replay view.
- `packages/duel-adapter`: bridge code that translates Neos service/protocol lifecycle signals into app-owned events such as `DuelResultFinalized`.
- `packages/duel-service`: app-side duel session orchestration, tournament-match linkage, result validation, finalization, and replay/log persistence hooks.
- `packages/shared`: shared duel session, player seat, team, and result payload types.
- `packages/web`: tournament pages, match pages, launch-duel flow, duel status display, and result display.
- `packages/ws`: may be reused for app-level duel room events, but Neos transport can remain isolated if that better preserves upstream compatibility.

## Duel Flow

1. A tournament match page exposes a `Start Duel` action when the current user has permission to launch the duel.
2. The app creates a duel session linked to the tournament match record.
3. The duel session assigns the two tournament players to explicit team and seat records.
4. The web app opens the Neos-based duel client with the session id and player identity.
5. Neos runs the duel through its WebSocket/backend protocol and adapted protobuf message flow.
6. The duel adapter observes high-level lifecycle signals and emits app-owned events.
7. When the duel completes, the adapter emits a final result payload to the duel service.
8. The duel service validates the payload against the session and tournament match.
9. The tournament service records the result and advances brackets or standings.
10. The web app displays the completed duel result and replay/log reference when available.

Casual duels can use the same session flow without a tournament match link. Casual completions write to match history only and do not update brackets.

## Result Contract

Tournament brackets must only advance from an app-owned finalized result event, not from raw client claims. The finalized result payload should include:

- duel session id
- tournament match id when tournament-backed
- source type: `tournament` or `casual`
- participating app user ids
- engine player ids or Neos seat identifiers
- team and seat assignments
- winner user id or winning team id
- score or game count; v1 stores `1-0` for the winner if Neos only reports a single-game winner
- engine-completed flag
- replay or log reference when available
- engine/protocol version metadata
- finalized timestamp

Duplicate result payloads for the same completed session must be idempotent and must not advance a bracket twice.

## Reliability And Failure Handling

Tournament sessions need explicit non-completed states. If a player disconnects briefly, the session should remain recoverable for a five-minute reconnect window in v1. If the duel resumes cleanly, the match continues. If the duel cannot resume, the app marks the session `interrupted` rather than `completed`.

Interrupted sessions do not update brackets automatically. Admins or authorized tournament users can resolve interrupted matches manually in the tournament UI. Cancelled or test sessions never write official tournament results.

## Future Tag Duel Compatibility

Do not implement tag duels in the first version. The first version supports `1v1` only.

Store team and seat explicitly from the beginning so a future `2v2` session can add four seats grouped into two teams. Avoid hardcoding tournament result logic around only `player1` and `player2`.

## GPL Compliance Boundary

Neos is GPL-3.0. The integrated duel portion must preserve GPL notices and source availability obligations. The app can still accept donations, charge for hosting, and offer paid support, but recipients of GPL-covered distributed client code must receive the GPL rights that come with it.

Keep the Neos-derived duel code visibly isolated in `packages/duel-web` and related duel integration packages. This does not remove GPL obligations, but it makes the compliance boundary easier to understand and audit.

## Testing

Initial testing should prioritize contracts and tournament safety:

- unit tests for duel session state transitions
- unit tests for result finalization validation
- unit tests that duplicate result payloads are idempotent
- integration test for tournament match to duel session creation
- integration test for completed duel result updating the bracket
- integration test that interrupted duels do not update the bracket
- UI test for launching a duel from a tournament match page
- UI test for displaying active, interrupted, and completed duel states

Separate Neos client rendering tests can follow once the vertical slice works.

## Delivery Plan

The first implementation milestone should prove one narrow vertical slice:

1. Run the Neos client in isolation in the repo context.
2. Define shared duel session and result contracts.
3. Create a tournament-linked duel session from one match page.
4. Connect a Neos completion signal to a `DuelResultFinalized` app event.
5. Record one completed duel result into the tournament match record.
6. Advance or update the bracket from that recorded result.

After that slice works, add reconnect handling, replay/log persistence, admin resolution of interrupted sessions, and tag-duel-ready UI refinements.

## Out Of Scope

This design does not implement a new TypeScript Yu-Gi-Oh rules engine, custom cards, tag duels, spectators, ranked matchmaking, AI opponents, anti-cheat beyond result validation, or a rewrite of the existing tournament system.

This design also does not decide whether Neos backend services are vendored, self-hosted as separate containers, or adapted into existing service packages. That choice belongs in the implementation plan after a local Neos runtime spike.
