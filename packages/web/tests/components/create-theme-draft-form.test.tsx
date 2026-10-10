// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateThemeDraftForm } from "../../src/components/draft/create-theme-draft-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

describe("CreateThemeDraftForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("offers player picking and random selection without host assignment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ channels: [{ id: "channel-1", name: "drafts" }] })));
    render(<CreateThemeDraftForm themeDraftsEnabled discordEnabled />);

    await screen.findByRole("option", { name: "#drafts" });
    expect(screen.getByLabelText(/draft name/i)).toHaveAttribute("placeholder", "Theme night");
    expect(screen.getByLabelText(/draft name/i).closest("section")?.className).toMatch(/sec/);
    expect(screen.getByLabelText(/main deck size/i)).toHaveValue(40);
    expect(screen.getByLabelText(/main deck size/i)).toHaveAttribute("min", "40");
    expect(screen.getByLabelText(/main deck size/i)).toHaveAttribute("max", "120");
    expect(screen.getByLabelText(/extra deck size/i)).toHaveValue(15);
    expect(screen.getByRole("checkbox", { name: /draft an extra deck/i })).toBeChecked();
    expect(screen.getByLabelText(/choices per pick/i)).toHaveValue(3);
    expect(screen.getByLabelText(/pick duration/i)).toHaveValue(45);

    const selection = screen.getByRole("group", { name: /theme selection/i });
    expect(selection.tagName).toBe("FIELDSET");
    expect(within(selection).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /players pick/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /random/i })).not.toBeChecked();
    expect(screen.queryByRole("radio", { name: /host assigned/i })).toBeNull();
  });

  it("closed: says theme drafts are not open, disables Create and sends nothing", () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateThemeDraftForm />);
    expect(screen.getByRole("status")).toHaveTextContent("Theme drafts are not open yet.");
    const create = screen.getByRole("button", { name: /create theme draft/i });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Theme Night" } });
    fireEvent.submit(create.closest("form")!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("open: shows no closed notice and enables Create", () => {
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    expect(screen.queryByText("Theme drafts are not open yet.")).toBeNull();
    expect(screen.getByRole("button", { name: /create theme draft/i })).toBeEnabled();
  });

  it("shows no channel picker, no Discord text and no channel request when the bot is off", async () => {
    const fetchMock = vi.fn(async () => Response.json({ channels: [{ id: "channel-1", name: "drafts" }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateThemeDraftForm themeDraftsEnabled discordEnabled={false} />);
    expect(screen.getByLabelText(/draft name/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/channel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/discord/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has a seat target of 4 that steps from 2 to 8 and is sent as lobbySeats", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/discord/channels") return Response.json({ channels: [] });
      if (String(input) === "/api/drafts" && init?.method === "POST") return Response.json({ webSlug: "theme-night" }, { status: 201 });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    const seats = screen.getByLabelText(/seats at the table/i) as HTMLInputElement;
    expect(seats).toHaveValue(4);
    const fewer = screen.getByRole("button", { name: "Fewer seats" });
    const more = screen.getByRole("button", { name: "More seats" });
    for (let i = 0; i < 5; i++) fireEvent.click(fewer);
    expect(seats).toHaveValue(2);
    expect(fewer).toBeDisabled();
    for (let i = 0; i < 9; i++) fireEvent.click(more);
    expect(seats).toHaveValue(8);
    expect(more).toBeDisabled();
    fireEvent.click(fewer);
    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Theme Night" } });
    expect(push).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /create theme draft/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/draft/theme-night"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).config).toMatchObject({ mode: "theme", lobbySeats: 7 });
  });

  it("refuses a seat count outside 2 to 8 and sends nothing", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ channels: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Theme Night" } });
    fireEvent.change(screen.getByLabelText(/seats at the table/i), { target: { value: "12" } });
    fireEvent.submit(screen.getByLabelText(/draft name/i).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/seats must be a number from 2 to 8/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps the advanced rules in a collapsible and shows Extra as an up-to number", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ channels: [] })));
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    const advanced = screen.getByText("Advanced settings").closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced).not.toHaveAttribute("open");
    expect(advanced).toContainElement(screen.getByLabelText(/main deck size/i));
    expect(screen.getByRole("complementary", { name: /draft summary/i })).toHaveTextContent(/Up to\s*15\s*picks/);
  });

  it("disables the Extra deck size when the Extra deck is off", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ channels: [] })));
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    const size = screen.getByLabelText(/extra deck size/i);
    expect(size).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /draft an extra deck/i }));
    expect(size).toBeDisabled();
    expect(screen.getByText("Not drafted")).toBeInTheDocument();
  });

  it("asks for a name before creating", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ channels: [] })));
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    fireEvent.click(screen.getByRole("button", { name: /create theme draft/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Draft name is required");
    expect(screen.getByLabelText(/draft name/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("blocks a pack size below 2 with the browser's own check, so no empty packs reach the server", async () => {
    const fetchMock = vi.fn(async () => Response.json({ channels: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Theme Night" } });
    const pack = screen.getByLabelText(/choices per pick/i) as HTMLInputElement;
    fireEvent.change(pack, { target: { value: "0" } });
    expect(pack.checkValidity()).toBe(false);
    expect(pack.closest("form")?.noValidate).toBe(false);
  });

  it("tells players they claim a theme only when players pick", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ channels: [] })));
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    const steps = screen.getByRole("list", { name: "What happens next" });
    expect(steps).toHaveTextContent("Players join and claim a theme.");
    fireEvent.click(screen.getByRole("radio", { name: /random/i }));
    expect(steps).not.toHaveTextContent("claim");
    expect(steps).toHaveTextContent("Everyone gets a random theme");
  });

  it.each(["player_pick", "random"])("creates a draft using %s", async (themeSelection) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/discord/channels") return Response.json({ channels: [] });
      if (String(input) === "/api/drafts" && init?.method === "POST") {
        return Response.json({ webSlug: "theme-night" }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateThemeDraftForm themeDraftsEnabled />);

    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Theme Night" } });
    fireEvent.click(screen.getByRole("radio", { name: themeSelection === "random" ? /random/i : /players pick/i }));
    fireEvent.click(screen.getByRole("button", { name: /create theme draft/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/draft/theme-night"));
    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/drafts" && init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: "Theme Night",
      config: { mode: "theme", themeSelection },
    });
  });

  it("hides the channel picker and skips the channels request when Discord is off", () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ channels: [{ id: "channel-1", name: "drafts" }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateThemeDraftForm themeDraftsEnabled />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/discord/i)).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("discord"))).toBe(false);
  });

  describe("who can join", () => {
    const stubCreate = () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/drafts" && init?.method === "POST") return Response.json({ webSlug: "theme-night" }, { status: 201 });
        return Response.json({ channels: [] });
      });
      vi.stubGlobal("fetch", fetchMock);
      return () => JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
    };

    it("offers Private (checked) and Open with their one-line meanings", () => {
      stubCreate();
      render(<CreateThemeDraftForm themeDraftsEnabled />);
      const group = screen.getByRole("group", { name: "Who can join" });
      expect(within(group).getByRole("radio", { name: /private/i })).toBeChecked();
      expect(within(group).getByRole("radio", { name: /open/i })).not.toBeChecked();
      expect(within(group).getByText("Only people with your invite link can see and join")).toBeInTheDocument();
      expect(within(group).getByText("Listed in Open right now for everyone")).toBeInTheDocument();
    });

    it("sends visibility private when nothing was changed", async () => {
      const body = stubCreate();
      render(<CreateThemeDraftForm themeDraftsEnabled />);
      fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Theme Night" } });
      fireEvent.click(screen.getByRole("button", { name: /create theme draft/i }));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/draft/theme-night"));
      expect(body().visibility).toBe("private");
    });

    it("sends visibility open when Open is chosen", async () => {
      const body = stubCreate();
      render(<CreateThemeDraftForm themeDraftsEnabled />);
      fireEvent.click(screen.getByRole("radio", { name: /open/i }));
      fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Theme Night" } });
      fireEvent.click(screen.getByRole("button", { name: /create theme draft/i }));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/draft/theme-night"));
      expect(body().visibility).toBe("open");
    });
  });
});
