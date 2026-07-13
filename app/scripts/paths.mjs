// Where this app's persistent state lives, all under the config volume
// mounted at /home/node so it survives container restarts. Centralized
// here rather than redefined per-file (gmail.mjs and authorize.mjs used to
// each hardcode TOKEN_PATH independently) so the paths can't drift apart.
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".mail-agent");

export const TOKEN_PATH = join(STATE_DIR, "gmail-token.json");
export const SEND_STATE_PATH = join(STATE_DIR, "send-state.json");
export const REAUTH_REMINDER_PATH = join(STATE_DIR, "reauth-reminder.json");
