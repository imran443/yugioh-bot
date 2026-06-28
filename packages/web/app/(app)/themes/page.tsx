import { ThemesList } from "@/components/themes/themes-list";

export default function ThemesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-text-primary sm:text-3xl">Themes</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Build reusable theme pools for Theme Drafts — seed from an archetype or import passcodes from scratch.
        </p>
      </div>
      <ThemesList />
    </div>
  );
}
