// Loaded with Node's --import before each compose app daemon entrypoint.
import { alertOnDrainStartup } from "./drain-startup-alert.ts";

// The daemon must not wait on observability or drain-state lock contention.
void alertOnDrainStartup().catch(() => undefined);
