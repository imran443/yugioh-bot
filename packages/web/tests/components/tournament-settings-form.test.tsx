// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TournamentSettingsForm } from "../../src/components/tournament/tournament-settings-form";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TournamentSettingsForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
  });

  it("submits the updated confirm window via PUT", async () => {
    const onSaved = vi.fn();
    render(
      <TournamentSettingsForm
        tournamentSlug="abc"
        initialDeadlineAt={undefined}
        initialReportConfirmWindowHours={24}
        onSaved={onSaved}
      />,
    );
    const hours = screen.getByLabelText(/confirm window/i);
    fireEvent.change(hours, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/tournaments/abc",
        expect.objectContaining({ method: "PUT" }),
      );
    });
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.reportConfirmWindowHours).toBe(6);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("sends deadlineAt: null when the deadline field is cleared", async () => {
    render(
      <TournamentSettingsForm
        tournamentSlug="abc"
        initialDeadlineAt={"2099-01-01T00:00:00.000Z"}
        initialReportConfirmWindowHours={undefined}
        onSaved={() => {}}
      />,
    );
    const deadline = screen.getByLabelText(/deadline/i);
    fireEvent.change(deadline, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.deadlineAt).toBeNull();
  });
});
