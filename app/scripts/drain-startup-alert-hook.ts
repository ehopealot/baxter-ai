// Loaded with Node's --import before each compose app daemon entrypoint.
import { alertOnDrainStartup } from "./drain-startup-alert.ts";

await alertOnDrainStartup();
