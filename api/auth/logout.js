// Clear the session cookie and bounce back to /api/auth/login (which will
// kick a fresh Google flow).

import { serializeCookie } from "../../lib/session.js";

export default function handler(req, res) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie("rs_session", "", { maxAge: 0 })
  );
  res.statusCode = 302;
  res.setHeader("Location", "/api/auth/login");
  res.end();
}
