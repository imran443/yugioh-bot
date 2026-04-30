# Dashboard Create Event Design

## Goal

Let users create a tournament from `/event dashboard` without remembering `/event create` syntax.

## Flow

1. User runs `/event dashboard`.
2. User clicks `Create Event`.
3. Bot replies privately with a format select menu.
4. User selects `round_robin` or `single_elim`.
5. Bot opens a Discord modal asking for the event name.
6. Bot creates a pending tournament owned by the submitting user.
7. Bot replies privately with confirmation and next-step guidance.

## Dashboard Button

Add `Create Event` to the dashboard's first row of buttons. It should show a private format select menu.

## Format Select

Use custom ID `dashboard_create_event_format`.

Options:

- `round_robin`
- `single_elim`

## Modal

Use custom ID `dashboard_create_event:<format>`, where `<format>` is the selected format.

Fields:

- `name`: required short text input, max 100 characters.

## Submission Behavior

On submit:

- Require the interaction to be in a server.
- Trim the event name.
- Reject empty names.
- Reject unsupported format custom IDs with a clear private message.
- Create the tournament with `tournaments.create(guildId, name, format, userId)`.
- Reply privately: `Event created: <name> (<format>). Use Creator Tools or /event signup name:<name> to manage signups.`

## Scope

This does not seed players. Discord modals cannot select users, so seeded participants stay in the slash command flow for now.

## Testing

Add tests for:

- Dashboard includes `Create Event` button.
- Clicking `Create Event` shows a format select.
- Choosing a format opens a name-only modal.
- Submitting valid modal input creates a pending tournament.
- Invalid format is rejected and does not create a tournament.
- Duplicate active or pending names return the existing duplicate-name error.
