import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      // Only allow the configured GitHub user
      const allowedId = process.env.ALLOWED_GITHUB_ID;
      if (!allowedId) return false;
      return String(profile?.id) === allowedId;
    },
    async jwt({ token, profile }) {
      if (profile?.id) {
        token.githubId = String(profile.id);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.githubId as string) || token.sub || "";
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});

// Guard for API routes — returns null if unauthorized, session if ok
export async function requireAuth(): Promise<{ userId: string } | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  if (session.user.id !== process.env.ALLOWED_GITHUB_ID) return null;
  return { userId: session.user.id };
}
