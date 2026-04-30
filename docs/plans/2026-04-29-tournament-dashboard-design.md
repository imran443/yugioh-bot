# Tournament Dashboard Design

## Goal

Add a private tournament dashboard that users can open with one slash command. The dashboard should make common tournament actions discoverable and reduce the need to remember command syntax.

## Command

Add `/event dashboard`.

The command replies ephemerally so only the user who opened it sees the controls.

## Dashboard Actions

The dashboard will show buttons for:

- Open Events
- My Events
- Report Match
- Pending Approvals
- Stats
- Creator Tools
- Help

## Open Events And Signup

`Open Events` shows pending tournaments in the server. Each listed tournament should include a join button when possible.

Joining stays a one-click action:

- User opens `/event dashboard`.
- User clicks `Open Events`.
- Bot shows pending events with join buttons.
- User clicks a tournament join button.
- Bot signs the user up and replies privately.

This reuses the existing `join_tournament:<id>` button behavior.

## My Events

`My Events` shows tournaments the user participates in, prioritizing active and pending events. It should include tournament name, status, format, and useful next action guidance.

## Report Match Flow

`Report Match` should avoid requiring users to remember `/event report`.

Flow:

- User clicks `Report Match`.
- Bot finds active tournaments the user is participating in.
- If no active tournaments exist, bot explains that there are no active matches to report.
- If one active tournament exists, bot shows open opponents for that tournament.
- If multiple active tournaments exist, bot asks the user to choose a tournament.
- User selects an open match or opponent.
- Bot shows result buttons: `I Won` and `I Lost`.
- User clicks a result.
- Bot creates the pending match report using the existing tournament report service.
- Opponent approval is still required before the result counts.

Button IDs should include enough context to complete the flow without storing temporary state in the database. For example:

- `dashboard_report_tournament:<tournamentId>`
- `dashboard_report_match:<tournamentMatchId>`
- `dashboard_report_result:<tournamentMatchId>:win`
- `dashboard_report_result:<tournamentMatchId>:loss`

## Pending Approvals

`Pending Approvals` shows the user's latest pending approval if one exists. It should include buttons for approve and deny so the user does not need to remember `/approve` or `/deny`.

The existing match approval rules remain unchanged:

- Only the opponent can approve or deny.
- Approved matches count toward stats.
- Denied matches do not count.

## Stats

`Stats` should show simple guidance for `/stats`, and when possible show the user's current relevant stats automatically:

- If the user is in one active tournament, show tournament stats.
- Otherwise show casual overall stats.

This mirrors the current `/stats` command behavior.

## Creator Tools

`Creator Tools` shows tournaments created by the user. It should explain creator-only actions and provide quick buttons where safe:

- Signup Post guidance or action for pending tournaments.
- Start guidance or action for pending tournaments.
- Cancel guidance or action for pending and active tournaments.
- Participants view for created tournaments.

Creator authorization remains enforced in the command or button handler before changing tournament state.

## Help

`Help` shows a concise plain-English command list. The goal is discovery, not exhaustive documentation.

## Error Handling

All dashboard responses should be ephemeral. Errors should be user-facing and concise:

- No pending events are open.
- You are not in any active tournaments.
- You have no pending approvals.
- Only the event creator can do that.
- Tournament not found in this server.

## Testing

Add tests for:

- `/event dashboard` returns the expected private dashboard content and buttons.
- Open Events lists pending tournaments and includes join buttons.
- Report Match shows active tournament choices for users in multiple active tournaments.
- Report Match shows open match choices for users in one active tournament.
- Result buttons create pending tournament reports with the correct winner.
- Pending Approvals exposes approve and deny buttons only when a pending approval exists.
- Creator-only dashboard actions still reject non-creators.
