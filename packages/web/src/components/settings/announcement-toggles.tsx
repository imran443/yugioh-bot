"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

type GuildSettings = {
  guildId: string;
  announceDraftCreated: boolean;
  announceDraftStarted: boolean;
  announceDraftCompleted: boolean;
  announceTournamentCreated: boolean;
  announceTournamentCompleted: boolean;
  announceChannelId: string | null;
};

type Channel = {
  id: string;
  name: string;
};

type ToggleProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3">
      <span className="text-sm text-text-primary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          checked ? "bg-accent-primary" : "bg-bg-elevated"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}

export function AnnouncementToggles() {
  const [settings, setSettings] = React.useState<GuildSettings | null>(null);
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/discord/channels").then((r) => r.json()).catch(() => ({ channels: [] })),
    ])
      .then(([settingsData, channelsData]) => {
        if (!cancelled) {
          setSettings(settingsData);
          setChannels(channelsData.channels ?? []);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = (key: keyof GuildSettings, value: boolean | string | null) => {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
    setSaved(false);
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        const updated = await res.json();
        setSettings(updated);
        setSaved(true);
      }
    } catch {
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="py-8 text-center text-text-secondary">Loading settings...</div>;
  }

  if (!settings) {
    return <div className="py-8 text-center text-text-secondary">Failed to load settings</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-3 font-heading text-lg text-text-primary">Draft Announcements</h2>
        <div className="space-y-2">
          <Toggle
            label="Draft Created"
            checked={settings.announceDraftCreated}
            onChange={(v) => handleChange("announceDraftCreated", v)}
          />
          <Toggle
            label="Draft Started"
            checked={settings.announceDraftStarted}
            onChange={(v) => handleChange("announceDraftStarted", v)}
          />
          <Toggle
            label="Draft Completed"
            checked={settings.announceDraftCompleted}
            onChange={(v) => handleChange("announceDraftCompleted", v)}
          />
        </div>
      </div>

      <div>
        <h2 className="mb-3 font-heading text-lg text-text-primary">Tournament Announcements</h2>
        <div className="space-y-2">
          <Toggle
            label="Tournament Created"
            checked={settings.announceTournamentCreated}
            onChange={(v) => handleChange("announceTournamentCreated", v)}
          />
          <Toggle
            label="Tournament Completed"
            checked={settings.announceTournamentCompleted}
            onChange={(v) => handleChange("announceTournamentCompleted", v)}
          />
        </div>
      </div>

      <div>
        <label htmlFor="announce-channel" className="mb-1 block text-sm font-medium text-text-primary">
          Announcement Channel
        </label>
        <select
          id="announce-channel"
          value={settings.announceChannelId ?? ""}
          onChange={(e) => handleChange("announceChannelId", e.target.value || null)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
        >
          <option value="">Default Channel</option>
          {channels.map((ch) => (
            <option key={ch.id} value={ch.id}>
              #{ch.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} loading={saving}>
          Save Settings
        </Button>
        {saved && <span className="text-sm text-accent-success">Settings saved</span>}
      </div>
    </div>
  );
}