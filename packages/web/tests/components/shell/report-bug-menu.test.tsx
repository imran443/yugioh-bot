// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LinkStub, fontMock, ready, stubFetch } from "./helpers";

vi.mock("next/font/google", () => fontMock());
vi.mock("next/navigation", () => ({ usePathname: vi.fn(() => "/leaderboard") }));
vi.mock("next/link", () => ({ default: LinkStub }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import { AccountMenu } from "../../../src/components/layout/account-menu";
import { AppShell } from "../../../src/components/layout/app-shell";

afterEach(cleanup);

describe("Report bug in the account menu", () => {
  it("shows no entry when the shell gives no handler", () => {
    render(<AccountMenu account={ready} pathname="/dashboard" variant="side" />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.queryByRole("menuitem", { name: "Report bug" })).toBeNull();
  });

  it("calls the handler, closes the menu and puts focus on the trigger", () => {
    const onReportBug = vi.fn();
    render(<AccountMenu account={ready} pathname="/dashboard" variant="phone" onReportBug={onReportBug} />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Report bug" }));
    expect(onReportBug).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Report bug in the app shell", () => {
  beforeEach(() => {
    stubFetch();
    window.history.replaceState(null, "", "/leaderboard");
  });

  it("opens a page report from the account menu and sends it with the path only", async () => {
    const send = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 2, issue: { number: 9, url: "https://github.com/imran443/yugioh-bot/issues/9" } }), { status: 200 }));
    const base = global.fetch;
    global.fetch = vi.fn((url: string, init?: RequestInit) => (url === "/api/bug-reports" ? send(url, init) : url === "/api/bug-reports/precheck" ? Promise.resolve(Response.json({ knownLimits: [], duplicates: [] })) : (base as typeof fetch)(url, init))) as unknown as typeof fetch;
    render(<AppShell><p>page</p></AppShell>);
    const triggers = await screen.findAllByRole("button", { name: /account menu/i });
    fireEvent.click(triggers[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Report bug" }));
    expect(screen.getByRole("dialog", { name: "Report a bug" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What went wrong\?/), { target: { value: "Ranks look wrong on the leaderboard page" } });
    fireEvent.change(screen.getByLabelText(/What did you expect\?/), { target: { value: "The ranks should be in order" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send report" })); });
    await screen.findByTestId("bug-report-done");
    const body = JSON.parse(send.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ description: "Ranks look wrong on the leaderboard page", path: "/leaderboard" });
    expect(body.duelSlug).toBeUndefined();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Report a bug" })).toBeNull());
  });

  it("from the phone menu: the field has focus behind no one, and closing the report returns focus to the menu button", async () => {
    render(<AppShell><p>page</p></AppShell>);
    const menuButton = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(menuButton);
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("button", { name: /account menu/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Report bug" }));
    const report = await screen.findByRole("dialog", { name: "Report a bug" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText(/What went wrong\?/));
    expect(report.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Report a bug" })).toBeNull());
    expect(document.activeElement).toBe(menuButton);
  });
});
