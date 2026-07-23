import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString, COMMENT_HEADER, type OpenAPI3 } from "openapi-typescript";

import { CANONICAL_OPENAPI_DOCUMENT } from "../src/openapi/canonical.js";
import { decorateOpenApiForDeployment } from "../src/openapi/deployment.js";

const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../test/generated/openapi.d.ts",
);

const usage = "Usage: pnpm openapi:generate [--check]";

const generatedDocument = (): OpenAPI3 => {
  const document = decorateOpenApiForDeployment(CANONICAL_OPENAPI_DOCUMENT, {
    deploymentProfile: "custom-domain-production",
    managedOauthEnabled: true,
    rateLimitMode: "workers-binding+waf",
  });

  // openapi-typescript normalizes its input in place, while deployment documents are immutable.
  return structuredClone(document) as unknown as OpenAPI3;
};

const generatedDeclaration = async (): Promise<string> => {
  const nodes = await openapiTS(generatedDocument(), {
    alphabetize: true,
    defaultNonNullable: false,
    exportType: true,
    silent: true,
  });
  const declaration = `${COMMENT_HEADER}${astToString(nodes)}`.replaceAll("\r\n", "\n");
  return declaration.endsWith("\n") ? declaration : `${declaration}\n`;
};

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const checkDeclaration = async (expected: string): Promise<void> => {
  let actual: string;
  try {
    actual = await readFile(OUTPUT_PATH, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error("Generated OpenAPI declaration is missing; run pnpm openapi:generate");
    }
    throw error;
  }

  if (actual !== expected) {
    throw new Error("Generated OpenAPI declaration is stale; run pnpm openapi:generate");
  }
};

const writeDeclaration = async (declaration: string): Promise<void> => {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const temporaryPath = `${OUTPUT_PATH}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, declaration, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, OUTPUT_PATH);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const main = async (): Promise<void> => {
  const arguments_ = process.argv.slice(2);
  const check = arguments_.length === 1 && arguments_[0] === "--check";
  if (arguments_.length > (check ? 1 : 0)) throw new Error(usage);

  const declaration = await generatedDeclaration();
  if (check) {
    await checkDeclaration(declaration);
    return;
  }
  await writeDeclaration(declaration);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "OpenAPI generation failed");
  process.exitCode = 1;
});
