#!/usr/bin/env node
// One-time interactive Gmail OAuth bootstrap. Run via `make auth`, which
// publishes port 8080 for the loopback redirect. Opens nothing itself
// (headless container) -- prints a URL for you to open in a real browser
// on your host. On success, writes a refresh token to
// ~/.mail-agent/gmail-token.json inside the persistent app config volume,
// which gmail.mjs reads on every subsequent run.
import { OAuth2Client } from "google-auth-library";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PORT = 8080;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const TOKEN_PATH = join(homedir(), ".mail-agent", "gmail-token.json");
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in app/.env first.");
  process.exit(1);
}

const client = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error || !code) {
    res.writeHead(400).end(`Authorization failed: ${error || "no code returned"}`);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh_token in response. Revoke prior access at https://myaccount.google.com/permissions and re-run -- Google only issues a refresh token on first consent.",
      );
    }
    mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2));
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<p>Authorized. You can close this tab and return to the terminal.</p>",
    );
    console.log(`Saved refresh token to ${TOKEN_PATH}`);
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500).end(String(err.message));
    console.error(err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  console.log("Open this URL in a browser and sign in as the dedicated Gmail account:\n");
  console.log(authUrl);
  console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...`);
});
