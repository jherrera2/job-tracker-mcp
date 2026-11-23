// A child process for test/integration/evals-signals.test.ts: runs `npm run evals` logic with a
// stand-in provider (recorded answers, a FAKE key: nothing is ever sent) and the REAL process
// signal handlers, so the test can send it a real SIGINT / SIGTERM at a chosen moment.
//
//   tsx test/support/evals-signal-child.ts <repeats> <schema> <outDir>
//
// The first model call prints "READY" and waits for a line on stdin before answering.
import { createInterface } from "node:readline";
import { runEvals } from "../../evals/src/main.js";
import { RecordedProvider } from "../../evals/src/provider.js";

const [repeats = "1", schema = "", outDir = ""] = process.argv.slice(2);
const recorded = new RecordedProvider(new URL("../../evals/recorded/", import.meta.url).pathname);
const stdin = createInterface({ input: process.stdin });
const nextLine = () => new Promise<void>((resolve) => stdin.once("line", () => resolve()));
let calls = 0;

process.exitCode = await runEvals(["--yes", "--cases", "java-onsite", "--repeats", repeats, "--out", outDir], {
  env: { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, ANTHROPIC_API_KEY: "sk-ant-api03-FAKE-CHILD-KEY-NEVER-SENT" },
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  newSchemaName: () => schema,
  createProvider: () => ({
    name: "anthropic",
    model: "claude-sonnet-5-5",
    complete: async (request) => {
      calls++;
      if (calls === 1) {
        console.log("READY");
        await nextLine();
      }
      return recorded.complete(request);
    },
  }),
});
stdin.close();
