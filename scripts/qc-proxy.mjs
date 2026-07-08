// Local reverse proxy to production with the QC session cookie injected.
// Lets the preview browser drive the live app without a Google login.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const token = readFileSync(new URL("../.qc-cookie", import.meta.url), "utf8").trim();
const UPSTREAM = "https://reading-spine.vercel.app";
const PORT = 3123;

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["accept-encoding"]; // keep upstream responses uncompressed
    headers.cookie = `rs_session=${token}`;
    const up = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
      redirect: "manual",
    });
    const out = {};
    up.headers.forEach((v, k) => {
      if (["content-encoding", "transfer-encoding", "content-length", "set-cookie"].includes(k)) return;
      out[k] = v;
    });
    const buf = Buffer.from(await up.arrayBuffer());
    res.writeHead(up.status, out);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("proxy error: " + e.message);
  }
}).listen(PORT, () => console.log(`qc-proxy on http://localhost:${PORT} -> ${UPSTREAM}`));
