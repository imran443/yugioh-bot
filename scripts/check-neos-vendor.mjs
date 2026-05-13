// scripts/check-neos-vendor.mjs
import { existsSync, readFileSync } from "node:fs";

function fail(message) {
  console.error(`Neos vendor check failed: ${message}`);
  process.exit(1);
}

function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    fail(`could not read JSON at ${url.pathname}: ${error.message}`);
  }
}

const neosPackageUrl = new URL("../vendor/neos-ts/package.json", import.meta.url);
const neosProtobufUrl = new URL("../vendor/neos-ts/neos-protobuf", import.meta.url);
const gitmodulesUrl = new URL("../.gitmodules", import.meta.url);

if (!existsSync(neosPackageUrl)) {
  fail("vendor/neos-ts/package.json is missing; run git submodule update --init --recursive vendor/neos-ts");
}

if (!existsSync(neosProtobufUrl)) {
  fail("vendor/neos-ts/neos-protobuf is missing; initialize nested submodules with --recursive");
}

if (!existsSync(gitmodulesUrl)) {
  fail(".gitmodules is missing; add vendor/neos-ts as a git submodule");
}

const gitmodules = readFileSync(gitmodulesUrl, "utf8");
if (!gitmodules.includes("vendor/neos-ts") || !gitmodules.includes("https://github.com/DarkNeos/neos-ts.git")) {
  fail(".gitmodules does not point vendor/neos-ts at https://github.com/DarkNeos/neos-ts.git");
}

const neosPackage = readJson(neosPackageUrl);
if (neosPackage.name !== "neos-ts") {
  fail(`expected Neos package name to be neos-ts, got ${neosPackage.name}`);
}

for (const scriptName of ["dev", "build"]) {
  if (!neosPackage.scripts?.[scriptName]) {
    fail(`vendor/neos-ts/package.json is missing the ${scriptName} script`);
  }
}

for (const dependencyName of ["react", "react-dom", "antd", "@vitejs/plugin-react"]) {
  if (!neosPackage.dependencies?.[dependencyName] && !neosPackage.devDependencies?.[dependencyName]) {
    fail(`vendor/neos-ts/package.json is missing ${dependencyName}`);
  }
}

console.log(`Neos vendor checkout ready: ${neosPackage.name}@${neosPackage.version}`);
