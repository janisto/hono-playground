import path from "node:path";
import { fileURLToPath } from "node:url";

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { build } from "vite";

import { COMPATIBILITY_DATE } from "../../infra/config.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const result = await build({
  configFile: false,
  logLevel: "warn",
  root: repositoryRoot,
  ssr: { noExternal: true },
  build: {
    minify: false,
    rolldownOptions: {
      external: [/^cloudflare:/u],
      input: path.join(repositoryRoot, "src", "index.ts"),
      output: {
        codeSplitting: false,
        entryFileNames: "worker.mjs",
        format: "es",
      },
    },
    ssr: true,
    target: "es2023",
    write: false,
  },
});

const outputs = Array.isArray(result) ? result.flatMap((buildResult) => buildResult.output) : result.output;
const entry = outputs.find((output) => output.type === "chunk" && output.isEntry);
if (entry?.type !== "chunk") {
  throw new Error("Vite did not produce a Worker entry chunk");
}

const worker = new Miniflare(
  convertV4MiniflareOptions({
    bindings: {
      ENVIRONMENT: "test",
      RATE_LIMIT_MODE: "none",
    },
    cf: false,
    compatibilityDate: COMPATIBILITY_DATE,
    host: "127.0.0.1",
    log: new Log(LogLevel.ERROR),
    modules: true,
    port: 8788,
    script: entry.code,
  }),
);

const url = await worker.ready;
console.log(`E2E Worker ready at ${url.origin}`);

const stop = async () => {
  await worker.dispose();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await new Promise(() => {});
