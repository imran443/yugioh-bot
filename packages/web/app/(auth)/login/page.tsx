import { signIn } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const errorMessages: Record<string, string> = {
  OAuthSignin: "Error starting Discord sign-in. Please try again.",
  OAuthCallback: "Discord authentication failed. Please try again.",
  OAuthAccountNotLinked: "This Discord account is not linked.",
  Callback: "Authentication callback error. Please try again.",
  AccessDenied: "Access denied. You may not be authorized.",
  Verification: "Verification failed. Please try again.",
  Configuration: "Server authentication misconfiguration.",
  Default: "An unexpected authentication error occurred. Please try again.",
};

interface LoginPageProps {
  searchParams: Promise<{ error?: string }> | { error?: string };
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = params.error;
  const errorMessage = error ? (errorMessages[error] ?? errorMessages.Default) : null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-bg-deep px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-surface p-8 shadow-card">
        <h1 className="text-center font-display text-2xl font-bold text-accent-primary">
          Yu-Gi-Oh! Tournament Manager
        </h1>
        <p className="mt-2 text-center font-body text-text-secondary">
          Sign in to manage your tournaments
        </p>
        {errorMessage && (
          <p className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-center text-sm text-red-400">
            {errorMessage}
          </p>
        )}
        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("discord", { redirectTo: "/dashboard" });
          }}
        >
          <Button type="submit" variant="primary" size="lg" className="w-full">
            Sign in with Discord
          </Button>
        </form>
      </div>
    </main>
  );
}
