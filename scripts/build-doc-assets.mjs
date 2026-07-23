import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SWAGGER_UI_VERSION = "5.32.11";
const HASH_LENGTH = 16;
const DOCS_ASSET_PREFIX = "/docs-assets/";
const CHECK_ARGUMENT = "--check";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDirectory);
const outputDirectory = join(repositoryRoot, "public", "docs-assets");
const manifestPath = join(repositoryRoot, "src", "generated", "docs-assets.ts");
const thirdPartyNoticesPath = join(repositoryRoot, "THIRD_PARTY_NOTICES.md");

const require = createRequire(import.meta.url);
const swaggerPackagePath = require.resolve("swagger-ui-dist/package.json");
const swaggerPackageDirectory = dirname(swaggerPackagePath);

const initializerSource = `(() => {
  "use strict";

  const noManualAuthorizationPlugin = () => ({
    wrapComponents: {
      authorizeBtn: () => () => null,
      authorizeOperationBtn: () => () => null,
    },
  });

  const mountAuthenticationNotice = () => {
    const swaggerRoot = document.querySelector("#swagger-ui");
    if (!(swaggerRoot instanceof HTMLElement)) {
      throw new Error("Swagger UI root element is missing");
    }

    const notice = document.createElement("aside");
    notice.className = "docs-auth-banner";
    notice.setAttribute("role", "note");

    const title = document.createElement("strong");
    title.textContent = "No token paste";

    const explanation = document.createElement("span");
    explanation.textContent =
      "Do not paste Cloudflare Access tokens into this page. Protected requests use only " +
      "your existing same-origin browser session. If needed, open /v1/profile in a " +
      "top-level tab and complete Access login first.";

    notice.append(title, explanation);
    swaggerRoot.before(notice);
  };

  const startSwaggerUi = () => {
    mountAuthenticationNotice();

    const SwaggerUIBundle = window.SwaggerUIBundle;
    if (typeof SwaggerUIBundle !== "function") {
      throw new Error("Swagger UI bundle failed to load");
    }

    window.ui = SwaggerUIBundle({
      url: "/openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      validatorUrl: null,
      queryConfigEnabled: false,
      persistAuthorization: false,
      withCredentials: true,
      layout: "BaseLayout",
      presets: [SwaggerUIBundle.presets.apis],
      plugins: [noManualAuthorizationPlugin],
      requestInterceptor(request) {
        const target = new URL(request.url, window.location.href);
        if (target.origin !== window.location.origin) {
          throw new Error("Swagger UI blocked a cross-origin request");
        }

        request.url = target.href;
        request.credentials = "include";
        return request;
      },
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startSwaggerUi, { once: true });
  } else {
    startSwaggerUi();
  }
})();
`;

const customStylesheetSource = `body {
  margin: 0;
  background: #fafafa;
  color: #3b4151;
}

.docs-auth-banner {
  box-sizing: border-box;
  max-width: 1460px;
  margin: 16px auto 0;
  padding: 14px 18px;
  border: 1px solid #b8d4ee;
  border-left: 5px solid #1f69a5;
  border-radius: 4px;
  background: #edf6ff;
  color: #17324d;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}

.docs-auth-banner strong {
  display: block;
  margin-bottom: 2px;
  font-size: 16px;
}

.swagger-ui .auth-wrapper,
.swagger-ui .authorization__btn,
.swagger-ui .btn.authorize,
.swagger-ui .dialog-ux .auth-container {
  display: none !important;
}

@media (max-width: 1492px) {
  .docs-auth-banner {
    margin-right: 16px;
    margin-left: 16px;
  }
}
`;

function toPosixPath(filePath) {
  return filePath.split(sep).join("/");
}

function repositoryRelativePath(filePath) {
  return toPosixPath(relative(repositoryRoot, filePath));
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex").slice(0, HASH_LENGTH);
}

function contentHashedFilename(stem, extension, contents) {
  return `${stem}.${digest(contents)}${extension}`;
}

function assetUrl(filename) {
  return `${DOCS_ASSET_PREFIX}${filename}`;
}

async function readRequiredSwaggerFile(filename) {
  return readFile(join(swaggerPackageDirectory, filename));
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readDirectoryEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function assertInitializerPolicy() {
  const requiredSettings = [
    'url: "/openapi.json"',
    "validatorUrl: null",
    "queryConfigEnabled: false",
    "persistAuthorization: false",
    "withCredentials: true",
  ];

  for (const setting of requiredSettings) {
    if (!initializerSource.includes(setting)) {
      throw new Error(`Initializer is missing required setting: ${setting}`);
    }
  }

  if (/https?:\/\//u.test(initializerSource)) {
    throw new Error("Initializer must not reference a remote URL");
  }

  if (!initializerSource.includes("No token paste")) {
    throw new Error("Initializer must render the no-token-paste notice");
  }
}

function createManifest(assetNames) {
  return `/**
 * Generated by scripts/build-doc-assets.mjs from swagger-ui-dist ${SWAGGER_UI_VERSION}.
 * Do not edit by hand. Run \`pnpm docs:assets\` instead.
 */
export const SWAGGER_UI_VERSION = "${SWAGGER_UI_VERSION}";

export const DOCS_ASSETS = {
  stylesheet: "${assetUrl(assetNames.stylesheet)}",
  customStylesheet: "${assetUrl(assetNames.customStylesheet)}",
  bundleScript: "${assetUrl(assetNames.bundleScript)}",
  initializerScript: "${assetUrl(assetNames.initializerScript)}",
  favicon16: "${assetUrl(assetNames.favicon16)}",
  favicon32: "${assetUrl(assetNames.favicon32)}",
  licenseNotice: "${assetUrl(assetNames.licenseNotice)}",
} as const;

export type DocsAssetKey = keyof typeof DOCS_ASSETS;
`;
}

function createThirdPartyNotices({ apacheLicense, bundleNotices, licenseFilename, notice }) {
  return `# Third-party notices

This file is generated by \`scripts/build-doc-assets.mjs\`. Do not edit it by hand.

## Swagger UI ${SWAGGER_UI_VERSION}

This repository redistributes selected files from
[\`swagger-ui-dist\`](https://www.npmjs.com/package/swagger-ui-dist) ${SWAGGER_UI_VERSION}:

- \`swagger-ui.css\`, modified only to remove its unused source-map pointer and add a
  modification notice;
- \`swagger-ui-bundle.js\`, modified only to point its license header at the
  content-hashed notice file;
- the 16x16 and 32x32 Swagger UI favicons, copied without modification.

The browser-readable combined license and bundled dependency notices are committed at
[\`public/docs-assets/${licenseFilename}\`](public/docs-assets/${licenseFilename}).

Upstream source: <https://github.com/swagger-api/swagger-ui>

License: Apache License 2.0

### Upstream NOTICE

\`\`\`text
${notice.trimEnd()}
\`\`\`

### Apache License 2.0

\`\`\`text
${apacheLicense.trimEnd()}
\`\`\`

### Notices embedded in the Swagger UI bundle

\`\`\`text
${bundleNotices.trimEnd()}
\`\`\`
`;
}

function createBrowserLicenseNotice({ apacheLicense, bundleNotices, notice }) {
  return `Swagger UI ${SWAGGER_UI_VERSION}

UPSTREAM NOTICE
===============
${notice.trimEnd()}

APACHE LICENSE 2.0
==================
${apacheLicense.trimEnd()}

NOTICES EMBEDDED IN THE SWAGGER UI BUNDLE
==========================================
${bundleNotices.trimEnd()}
`;
}

function rewriteBundleLicenseReference(bundle, licenseFilename) {
  const originalHeader =
    "/*! For license information please see swagger-ui-bundle.js.LICENSE.txt */";
  const bundleSource = bundle.toString("utf8");
  if (!bundleSource.startsWith(originalHeader)) {
    throw new Error("Unexpected swagger-ui-bundle.js license header");
  }

  const generatedHeader = [
    "/*! Modified by hono-playground: license reference uses a content-hashed filename. */",
    `/*! For license information please see ${licenseFilename} */`,
  ].join("\n");

  return Buffer.from(generatedHeader + bundleSource.slice(originalHeader.length), "utf8");
}

function removeStylesheetSourceMapReference(stylesheet) {
  const sourceMapSuffix = "\n\n/*# sourceMappingURL=swagger-ui.css.map*/";
  const stylesheetSource = stylesheet.toString("utf8");
  if (!stylesheetSource.endsWith(sourceMapSuffix)) {
    throw new Error("Unexpected swagger-ui.css source-map footer");
  }

  const generatedHeader =
    "/*! Modified by hono-playground: unused source-map reference removed. */\n";
  const stylesheetWithoutSourceMap = stylesheetSource.slice(0, -sourceMapSuffix.length);
  return Buffer.from(`${generatedHeader}${stylesheetWithoutSourceMap}\n`, "utf8");
}

async function buildExpectedOutputs() {
  assertInitializerPolicy();

  const packageJson = JSON.parse(await readFile(swaggerPackagePath, "utf8"));
  if (packageJson.name !== "swagger-ui-dist" || packageJson.version !== SWAGGER_UI_VERSION) {
    throw new Error(
      `Expected swagger-ui-dist ${SWAGGER_UI_VERSION}, found ${String(packageJson.version)}`,
    );
  }
  if (packageJson.license !== "Apache-2.0") {
    throw new Error(`Unexpected swagger-ui-dist license: ${String(packageJson.license)}`);
  }

  const [
    upstreamStylesheet,
    upstreamBundle,
    favicon16,
    favicon32,
    apacheLicenseBuffer,
    noticeBuffer,
    bundleNoticesBuffer,
  ] = await Promise.all([
    readRequiredSwaggerFile("swagger-ui.css"),
    readRequiredSwaggerFile("swagger-ui-bundle.js"),
    readRequiredSwaggerFile("favicon-16x16.png"),
    readRequiredSwaggerFile("favicon-32x32.png"),
    readRequiredSwaggerFile("LICENSE"),
    readRequiredSwaggerFile("NOTICE"),
    readRequiredSwaggerFile("swagger-ui-bundle.js.LICENSE.txt"),
  ]);

  const apacheLicense = apacheLicenseBuffer.toString("utf8");
  const notice = noticeBuffer.toString("utf8");
  const bundleNotices = bundleNoticesBuffer.toString("utf8");
  const browserLicenseNotice = Buffer.from(
    createBrowserLicenseNotice({ apacheLicense, bundleNotices, notice }),
    "utf8",
  );
  const licenseFilename = contentHashedFilename("swagger-ui-license", ".txt", browserLicenseNotice);
  const generatedBundle = rewriteBundleLicenseReference(upstreamBundle, licenseFilename);
  const generatedStylesheet = removeStylesheetSourceMapReference(upstreamStylesheet);
  const initializer = Buffer.from(initializerSource, "utf8");
  const customStylesheet = Buffer.from(customStylesheetSource, "utf8");

  const assetNames = {
    stylesheet: contentHashedFilename("swagger-ui", ".css", generatedStylesheet),
    customStylesheet: contentHashedFilename("swagger-ui-custom", ".css", customStylesheet),
    bundleScript: contentHashedFilename("swagger-ui-bundle", ".js", generatedBundle),
    initializerScript: contentHashedFilename("swagger-ui-initializer", ".js", initializer),
    favicon16: contentHashedFilename("swagger-ui-favicon-16x16", ".png", favicon16),
    favicon32: contentHashedFilename("swagger-ui-favicon-32x32", ".png", favicon32),
    licenseNotice: licenseFilename,
  };

  for (const filename of Object.values(assetNames)) {
    if (filename.endsWith(".html")) {
      throw new Error(`HTML must not be generated under public: ${filename}`);
    }
  }

  const publicAssets = new Map([
    [assetNames.stylesheet, generatedStylesheet],
    [assetNames.customStylesheet, customStylesheet],
    [assetNames.bundleScript, generatedBundle],
    [assetNames.initializerScript, initializer],
    [assetNames.favicon16, favicon16],
    [assetNames.favicon32, favicon32],
    [assetNames.licenseNotice, browserLicenseNotice],
  ]);
  const manifest = Buffer.from(createManifest(assetNames), "utf8");
  const thirdPartyNotices = Buffer.from(
    createThirdPartyNotices({
      apacheLicense,
      bundleNotices,
      licenseFilename,
      notice,
    }),
    "utf8",
  );

  const files = new Map();
  for (const [filename, contents] of publicAssets) {
    files.set(join(outputDirectory, filename), contents);
  }
  files.set(manifestPath, manifest);
  files.set(thirdPartyNoticesPath, thirdPartyNotices);

  return { files, publicAssets };
}

async function findFreshnessProblems(files, expectedPublicAssetNames) {
  const problems = [];

  for (const [filePath, expectedContents] of files) {
    const existingContents = await readOptionalFile(filePath);
    if (existingContents === undefined) {
      problems.push(`missing: ${repositoryRelativePath(filePath)}`);
    } else if (!existingContents.equals(expectedContents)) {
      problems.push(`stale: ${repositoryRelativePath(filePath)}`);
    }
  }

  const directoryEntries = await readDirectoryEntries(outputDirectory);
  for (const entry of directoryEntries) {
    if (!expectedPublicAssetNames.has(entry.name)) {
      problems.push(`unexpected: ${repositoryRelativePath(join(outputDirectory, entry.name))}`);
    }
  }

  return problems;
}

async function writeExpectedOutputs(files, expectedPublicAssetNames) {
  for (const [filePath, contents] of files) {
    await mkdir(dirname(filePath), { recursive: true });
    const existingContents = await readOptionalFile(filePath);
    if (existingContents === undefined || !existingContents.equals(contents)) {
      await writeFile(filePath, contents);
    }
  }

  const directoryEntries = await readDirectoryEntries(outputDirectory);
  for (const entry of directoryEntries) {
    if (expectedPublicAssetNames.has(entry.name)) {
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(
        `Refusing to remove unexpected directory ${repositoryRelativePath(
          join(outputDirectory, entry.name),
        )}`,
      );
    }
    await unlink(join(outputDirectory, entry.name));
  }
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const checkOnly = argumentsList.length === 1 && argumentsList[0] === CHECK_ARGUMENT;
  if (argumentsList.length > (checkOnly ? 1 : 0)) {
    throw new Error(`Usage: node scripts/build-doc-assets.mjs [${CHECK_ARGUMENT}]`);
  }

  const { files, publicAssets } = await buildExpectedOutputs();
  const expectedPublicAssetNames = new Set(publicAssets.keys());

  if (checkOnly) {
    const problems = await findFreshnessProblems(files, expectedPublicAssetNames);
    if (problems.length > 0) {
      throw new Error(`Generated documentation assets are not fresh:\n- ${problems.join("\n- ")}`);
    }
    console.log(`Documentation assets are fresh (${publicAssets.size} content-hashed files).`);
    return;
  }

  await writeExpectedOutputs(files, expectedPublicAssetNames);
  console.log(`Generated ${publicAssets.size} content-hashed documentation assets.`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
