// Entry point for `npm run evals` (package.json). All the logic is in main.ts.
// npm passes .env through `--env-file-if-exists=.env`; the API key is read from ANTHROPIC_API_KEY.
import { createAnthropicProvider } from "./anthropic-provider.js";
import { runEvals } from "./main.js";

process.exitCode = await runEvals(process.argv.slice(2), {
  env: process.env,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  createProvider: createAnthropicProvider,
});
