// Clear the session cookie and bounce to the HOME page, which renders the
// logged-out welcome / "Sign in" screen.
//
// IMPORTANT: do NOT redirect to /api/auth/login here. That endpoint kicks a
// fresh SSO flow, and because the upstream IdP session (Cognito/Google) is
// still alive in the tab, the user gets SILENTLY re-authenticated straight
// back in — i.e. "Sign out" appears to do nothing (the bug). Landing on "/"
// with the cleared cookie shows the welcome screen and lets the kid choose to
// sign in again. (We can't clear the IdP's own session from here — that's a
// Cognito logout-endpoint concern — but landing on "/" stops the auto-loop.)

import { serializeCookie } from "../../lib/session.js";

export default function handler(req, res) {
  res.setHeader("Set-Cookie", [
    serializeCookie("rs_session", "", { maxAge: 0 }),
    serializeCookie("rs_oauth_state", "", { maxAge: 0 }),
    serializeCookie("rs_pkce_verifier", "", { maxAge: 0 }),
  ]);
  res.statusCode = 302;
  res.setHeader("Location", "/?signed_out=1");
  res.end();
  // NOTE: this clears OUR session and lands on the welcome screen, which fixes
  // the "Sign out does nothing" loop (we no longer redirect into /api/auth/
  // login, which was silently re-authenticating). It does NOT end the upstream
  // Cognito/Google IdP session — so on a shared device the next "Sign in" may
  // re-authenticate the same student without a prompt. Ending the IdP session
  // needs Cognito's /logout endpoint, which requires our sign-out URL to be
  // registered as an allowed sign-out URL on the app client (currently it
  // bounces to the Cognito login page instead). Flagged for TimeBack.
}
