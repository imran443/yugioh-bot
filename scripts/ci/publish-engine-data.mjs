/** Publish the reviewed data-only artifact. Uses Node builtins and git/gh; never installs or executes candidate code. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PIN_FILE = "packages/duel-server/scripts/prepare-data.ts";
const CORE_PIN_FILES = ["packages/duel-server/domain-core/pins.json", "packages/duel-server/legacy-1v1/domain-core/pins.json"];
const PIN_FILES = [PIN_FILE, ...CORE_PIN_FILES];
export const BOT = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };
const pinKeys = ["scripts", "database", "strings"];
const pinPattern = (key) => new RegExp(`(["']?\\b${key}\\b["']?\\s*:\\s*["'])([a-f0-9]{40})(["'])`, "g");

export function readPinsFromSource(source) {
  return Object.fromEntries(pinKeys.map((key) => {
    const matches = [...source.matchAll(pinPattern(key))];
    if (matches.length !== 1) throw new Error(`Expected exactly one ${key} data pin in ${PIN_FILE}`);
    return [key, matches[0][2]];
  }));
}

export function hasHumanCommits(authors) {
  return authors.split("\n").filter(Boolean).some((line) => line !== `${BOT.name}\0${BOT.email}`);
}

export function validateArtifact(artifact) {
  if (!artifact || typeof artifact.changed !== "boolean") throw new Error("Artifact changed must be boolean");
  if (!artifact.changed) return;
  if (!/^[a-f0-9]{40}$/.test(artifact.baseSha ?? "")) throw new Error("Artifact baseSha must be a full commit SHA");
  if (artifact.matchingPrHead !== undefined && !/^[a-f0-9]{40}$/.test(artifact.matchingPrHead)) {
    throw new Error("Artifact matchingPrHead must be a full commit SHA");
  }
  if (!Array.isArray(artifact.files) || !artifact.files.includes(PIN_FILE) ||
      new Set(artifact.files).size !== artifact.files.length || artifact.files.some((file) => !PIN_FILES.includes(file))) {
    throw new Error(`Artifact files must match the exact allowlist: ${PIN_FILES.join(", ")}`);
  }
  if (!artifact.next || Object.keys(artifact.next).length !== pinKeys.length ||
      pinKeys.some((key) => !/^[a-f0-9]{40}$/.test(artifact.next[key] ?? ""))) {
    throw new Error("Artifact next must contain exactly three full data pin SHAs");
  }
}

function defaultRun(command, args, options) {
  return execFileSync(command, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** run(command, argv, {cwd, env}) is injectable for tests; it returns stdout or throws on failure. */
export async function publishEngineData({ cwd = process.cwd(), env = process.env, run = defaultRun, log = console.log } = {}) {
  if (!env.UPDATE_ARTIFACT_DIR) throw new Error("UPDATE_ARTIFACT_DIR is required");
  const artifactDir = resolve(cwd, env.UPDATE_ARTIFACT_DIR);
  const artifact = JSON.parse(readFileSync(join(artifactDir, "update.json"), "utf8"));
  validateArtifact(artifact);
  const skip = (reason) => { log(`::warning::Engine data publication skipped: ${reason}`); return { status: "skipped", reason, pushed: false }; };
  if (!artifact.changed) return skip("unchanged");
  const base = env.BASE_BRANCH || "main";
  const branch = env.UPDATE_BRANCH || "chore/engine-data-update";
  const repo = env.GH_REPO;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GH_REPO must be owner/repository");
  const git = (...args) => run("git", args, { cwd, env });
  const gh = (...args) => run("gh", args, { cwd, env });
  git("check-ref-format", `refs/heads/${base}`);
  git("check-ref-format", `refs/heads/${branch}`);
  if (base === branch) throw new Error("Update branch must differ from the base branch");
  const baseRef = `refs/remotes/origin/${base}`;
  const updateRef = `refs/remotes/origin/${branch}`;
  git("fetch", "--no-tags", "origin", `+refs/heads/${base}:${baseRef}`);
  const baseSha = git("rev-parse", baseRef).trim();
  // ls-remote distinguishes a genuinely absent branch from a failed fetch (which must fail publication).
  const branchExists = Boolean(git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).trim());
  const pr = gh("pr", "list", "--repo", repo, "--head", branch, "--base", base, "--state", "open", "--json", "url", "--jq", ".[0].url // empty").trim();
  let updateSha = "";
  if (branchExists) {
    git("fetch", "--no-tags", "origin", `+refs/heads/${branch}:${updateRef}`);
    updateSha = git("rev-parse", updateRef).trim();
    const authors = git("log", "--format=%an%x00%ae", `${baseRef}..${updateRef}`);
    if (pr && hasHumanCommits(authors)) {
      const temporary = mkdtempSync(join(tmpdir(), "engine-data-comment-"));
      try {
        const body = join(temporary, "comment.md");
        const runUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID || ""}`;
        writeFileSync(body, `Engine data update skipped because this branch contains commits authored by someone other than the exact GitHub Actions bot identity. Preserving those changes; no push or CI dispatch was performed.\n\nRun: ${runUrl}\n`);
        gh("pr", "comment", pr, "--repo", repo, "--body-file", body);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
      return skip("human-commits");
    }
  }
  if (baseSha !== artifact.baseSha) return skip("base-advanced");
  if (updateSha && pr) {
    const current = readPinsFromSource(git("show", `${updateSha}:${PIN_FILE}`));
    if (pinKeys.every((key) => current[key] === artifact.next[key])) return skip("identical-pins");
    if (artifact.matchingPrHead === updateSha) return skip("identical-data");
  }
  const original = git("show", `${baseSha}:${PIN_FILE}`);
  const old = readPinsFromSource(original);
  if (pinKeys.every((key) => old[key] === artifact.next[key])) return skip("identical-pins");
  let expected = original;
  for (const key of pinKeys) expected = expected.replace(pinPattern(key), (_, prefix, _old, suffix) => `${prefix}${artifact.next[key]}${suffix}`);
  const expectedSources = new Map([[PIN_FILE, expected]]);
  for (const file of CORE_PIN_FILES) {
    const source = git("show", `${baseSha}:${file}`);
    const pattern = /("cardScripts"\s*:\s*\{[^{}]*"commit"\s*:\s*")([a-f0-9]{40})(")/g;
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1 || matches[0][2] !== old.scripts || JSON.parse(source).cardScripts?.commit !== old.scripts) {
      throw new Error(`Expected a synchronized cardScripts pin in ${file}`);
    }
    const updated = source.replace(pattern, (_, prefix, _old, suffix) => `${prefix}${artifact.next.scripts}${suffix}`);
    if (updated !== source) expectedSources.set(file, updated);
  }
  const expectedFiles = [...expectedSources.keys()].sort();
  if (JSON.stringify([...artifact.files].sort()) !== JSON.stringify(expectedFiles)) {
    throw new Error("Artifact files must include exactly the changed synchronized pin files");
  }

  // Apply only to a disposable index, then verify exact paths, modes and pin-only content. The untrusted patch
  // never touches the working tree; only the verified expected source is written after validation succeeds.
  const temporary = mkdtempSync(join(tmpdir(), "engine-data-index-"));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: join(temporary, "index") };
    const indexGit = (...args) => run("git", args, { cwd, env: indexEnv });
    indexGit("read-tree", baseSha);
    indexGit("apply", "--cached", "--check", join(artifactDir, "update.patch"));
    indexGit("apply", "--cached", join(artifactDir, "update.patch"));
    const changed = indexGit("diff", "--cached", "--name-status", "-z", baseSha);
    if (changed !== expectedFiles.map((file) => `M\0${file}\0`).join("")) throw new Error("Patch changes files outside the exact pin allowlist");
    for (const [file, source] of expectedSources) {
      const modeBefore = git("ls-tree", baseSha, "--", file).split(" ")[0];
      const modeAfter = indexGit("ls-files", "--stage", "--", file).split(" ")[0];
      if (modeBefore !== "100644" || modeAfter !== modeBefore) throw new Error("Patch must preserve the regular pin file mode");
      if (indexGit("show", `:${file}`) !== source) throw new Error(`Patch must only replace the data pins in ${file}`);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }

  if (git("status", "--porcelain", "--untracked-files=no").trim()) throw new Error("Publication requires a clean tracked checkout");
  const body = join(artifactDir, existsSync(join(artifactDir, "pr-body.md")) ? "pr-body.md" : "report.md");
  readFileSync(body, "utf8"); // Require a usable report before publishing the branch.
  git("switch", "--detach", baseSha);
  for (const [file, source] of expectedSources) writeFileSync(join(cwd, file), source);
  git("add", "--", ...artifact.files);
  const title = `chore(engine): update Project Ignis card data to ${new Date().toISOString().slice(0, 10)}`;
  const authorEnv = { ...env, GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email, GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email };
  run("git", ["-c", "commit.gpgsign=false", "commit", "-m", title], { cwd, env: authorEnv });
  // An explicit empty lease protects branch creation too. A new commit after our fetch makes the push fail.
  git("push", `--force-with-lease=refs/heads/${branch}:${updateSha}`, "origin", `HEAD:refs/heads/${branch}`);
  let prUrl = pr;
  if (prUrl) gh("pr", "edit", prUrl, "--repo", repo, "--title", title, "--body-file", body);
  else prUrl = gh("pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body-file", body).trim();
  if (!/^https:\/\/\S+\/pull\/\d+$/.test(prUrl)) throw new Error("gh did not return a pull request URL");
  const labels = gh("api", "--paginate", `repos/${repo}/labels?per_page=100`, "--jq", ".[].name").trim().split("\n");
  if (labels.includes("engine-data")) gh("pr", "edit", prUrl, "--repo", repo, "--add-label", "engine-data");
  if (env.HAS_PR_TOKEN !== "true") gh("workflow", "run", "test.yml", "--repo", repo, "--ref", branch, "-f", "nightly=false");
  log(`Engine data update published: ${prUrl}`);
  return { status: "published", pushed: true, prUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishEngineData().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
