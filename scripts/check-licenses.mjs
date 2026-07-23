import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const directRuntimeDependencies = Object.keys(packageJson.dependencies ?? {}).sort();
const approvedProductionLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

const command = spawnSync("pnpm", ["licenses", "list", "--json", "--prod"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});

if (command.error !== undefined) {
  console.error(`Unable to run pnpm license inventory: ${command.error.message}`);
  process.exit(1);
}

if (command.status !== 0) {
  console.error("pnpm license inventory failed:");
  console.error(command.stderr.trim() || command.stdout.trim());
  process.exit(command.status ?? 1);
}

let inventory;
try {
  inventory = JSON.parse(command.stdout);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`pnpm returned an unreadable license inventory: ${reason}`);
  process.exit(1);
}

const packagesByName = new Map();
let inventoryPackageCount = 0;
for (const [groupLicense, packages] of Object.entries(inventory)) {
  if (!Array.isArray(packages)) {
    continue;
  }

  for (const packageRecord of packages) {
    if (typeof packageRecord?.name !== "string") {
      continue;
    }

    inventoryPackageCount += 1;
    const licenses = packagesByName.get(packageRecord.name) ?? new Set();
    const declaredLicense =
      typeof packageRecord.license === "string" ? packageRecord.license : groupLicense;
    licenses.add(declaredLicense.trim());
    packagesByName.set(packageRecord.name, licenses);
  }
}

const failures = [];
for (const dependency of directRuntimeDependencies) {
  const licenses = packagesByName.get(dependency);
  if (licenses === undefined || licenses.size === 0) {
    failures.push(`${dependency}: absent from pnpm's production license inventory`);
    continue;
  }

  const unapproved = [...licenses].filter((license) => !approvedProductionLicenses.has(license));
  if (unapproved.length > 0) {
    failures.push(
      `${dependency}: incompatible or unknown direct runtime license metadata (${unapproved.join(", ")})`,
    );
  }
}

for (const [dependency, licenses] of packagesByName) {
  const unapproved = [...licenses].filter((license) => !approvedProductionLicenses.has(license));
  if (unapproved.length > 0 && !directRuntimeDependencies.includes(dependency)) {
    failures.push(
      `${dependency}: incompatible or unknown transitive production license metadata (${unapproved.join(", ")})`,
    );
  }
}

console.log(
  `Production inventory: ${inventoryPackageCount} package records across ${Object.keys(inventory).length} license groups.`,
);
for (const dependency of directRuntimeDependencies) {
  const licenses = packagesByName.get(dependency);
  console.log(
    `- direct ${dependency}: ${licenses === undefined ? "missing" : [...licenses].join(", ")}`,
  );
}

if (failures.length > 0) {
  console.error("Production dependency license policy check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    "Direct and transitive production license metadata passed the project allowlist. This inventory is not legal advice or a source-code audit.",
  );
}
