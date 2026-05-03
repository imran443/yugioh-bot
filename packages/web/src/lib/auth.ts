import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";

const requiredEnv = [
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
] as const;

const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (!isBuildPhase) {
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(
        `[auth] Missing required environment variable: ${key}. Please check your .env file.`
      );
    }
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token }) {
      return token;
    },
    async session({ session, token }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
      }
      return session;
    },
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublicRoute =
        nextUrl.pathname === "/login" || nextUrl.pathname.startsWith("/api/auth");

      if (!isLoggedIn && !isPublicRoute) {
        return false;
      }

      return true;
    },
  },
});
