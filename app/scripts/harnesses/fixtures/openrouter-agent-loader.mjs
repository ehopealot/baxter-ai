const AGENT_URL = "runner-test:openrouter-agent";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@openrouter/agent") return { url: AGENT_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url !== AGENT_URL) return nextLoad(url, context);
  return {
    format: "module",
    shortCircuit: true,
    source: `
      export const tool = config => config;
      export const stepCountIs = () => () => false;
      export const maxTokensUsed = () => () => false;

      const revoked = () => {
        const authority = new Error("worker lease revoked");
        authority.name = "LeaseRevokedError";
        return new Error("Unexpected HTTP client error", { cause: authority });
      };

      export class OpenRouter {
        calls = 0;
        constructor() {}
        callModel(options) {
          const call = ++this.calls;
          const scenario = process.env.BAXTER_OPENROUTER_RUNNER_TEST_SCENARIO;
          const runCli = async params => {
            const cli = options.tools.find(candidate => candidate.name === "run_cli");
            if (!cli) throw new Error("run_cli was not configured in the test");
            await cli.execute(params);
          };
          return {
            async getText() {
              if (scenario === "revoked-after-delivery") {
                await runCli({ cli: "discord-cli", args: ["reply", "channel", "message"], stdin: "hello" });
                throw revoked();
              }
              if (scenario === "revoked-during-nudge") {
                if (call === 1) return "draft response";
                throw revoked();
              }
              if (scenario === "revoked-final-wrap") {
                await runCli({ cli: "sms-cli", args: ["skip"], stdin: "nothing actionable" });
                return "";
              }
              return "done";
            },
            async *getFullResponsesStream() {
              if (scenario === "revoked-final-wrap") throw revoked();
            },
          };
        }
      }
    `,
  };
}
