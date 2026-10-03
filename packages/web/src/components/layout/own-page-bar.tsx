/**
 * Put this on a page that draws its own `PageBar` as the first thing in the page.
 *
 * It renders nothing visible. The shell sees it (CSS `:has`, so there is no flash on the first
 * paint) and, in response:
 *  - hides its own 56px phone bar, so two bars don't stack;
 *  - removes the page padding around the content, so your bar runs edge to edge and its line
 *    sits level with the sidebar's brand line.
 *
 * Then put `<ShellMenuButton />` in your bar's `actions`, so the phone still has a menu button.
 * The page handles its own padding below the bar. A server component is fine.
 *
 * The shell keeps 64px at the end of the content so the last row clears the Report bug button. A page that has its
 * own room at the end (a body with bottom padding, or a full-height workspace that must not scroll) passes `room`
 * and the shell adds nothing, so the two do not stack.
 */
export function OwnsPageBar({ room = false }: { room?: boolean }) {
  return <span hidden data-shell-bar="own" data-shell-room={room ? "own" : undefined} />;
}
