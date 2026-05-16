import { AnnouncementToggles } from "@/components/settings/announcement-toggles";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <h1 className="font-heading text-2xl text-text-primary">Settings</h1>
      <AnnouncementToggles />
    </div>
  );
}
