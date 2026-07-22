import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Real session-based auth issuing a signed JWT session cookie that the
// Socket.IO handshake verifies.
// - Google: real OAuth. Needs AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET (Auth.js
//   reads these automatically) and the callback URL registered in Google Cloud.
export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [Google],
  callbacks: {
    jwt({ token, user }) {
      // Stable identity key: the user's email.
      if (user) token.uid = user.email || (user as { id?: string }).id;
      return token;
    },
    session({ session, token }) {
      if (token.uid) (session.user as { id?: string }).id = token.uid as string;
      return session;
    },
  },
});
