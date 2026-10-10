import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const { publishEngineData, hasHumanCommits } = await import(fileURLToPath(new URL("../../../scripts/ci/publish-engine-data.mjs", import.meta.url)));
const roots: string[] = [];
const prepare = "packages/duel-server/scripts/prepare-data.ts";
const coreFiles = ["packages/duel-server/domain-core/pins.json", "packages/duel-server/legacy-1v1/domain-core/pins.json"];
const coreSource = (scripts: string) => JSON.stringify({ ygoproCore: { commit: "1".repeat(40) }, cardScripts: { repository: "https://github.com/ProjectIgnis/CardScripts", commit: scripts } }, null, 2) + "\n";
const bot = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };
const old = { scripts: "a".repeat(40), database: "b".repeat(40), strings: "c".repeat(40) };
const next = { scripts: "d".repeat(40), database: "e".repeat(40), strings: "f".repeat(40) };
const source = (pins = old) => `const sources = {\n  scripts: "${pins.scripts}",\n  database: "${pins.database}",\n  strings: "${pins.strings}",\n};\nconsole.log("untouched");\n`;
const existingUrl = "https://github.com/test/repo/pull/123";
const createdUrl = "https://github.com/test/repo/pull/456";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(candidate = next) {
  const root = mkdtempSync(join(tmpdir(), "publish-data-"));
  roots.push(root);
  const cwd = join(root, "checkout");
  const remote = join(root, "remote.git");
  const artifact = join(root, "artifact");
  mkdirSync(cwd); mkdirSync(artifact);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", bot.name); git("config", "user.email", bot.email);
  git("config", "maintenance.auto", "false"); git("config", "gc.auto", "0");
  git("remote", "add", "origin", remote);
  mkdirSync(dirname(join(cwd, prepare)), { recursive: true });
  writeFileSync(join(cwd, prepare), source());
  for (const file of coreFiles) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), coreSource(old.scripts));
  }
  git("add", prepare, ...coreFiles); git("commit", "-qm", "base"); git("push", "origin", "main");
  const baseSha = git("rev-parse", "HEAD");
  const update = { changed: true, next: candidate, files: [prepare, ...(candidate.scripts === old.scripts ? [] : coreFiles)], baseSha };
  function patch(content = source(candidate), extra?: string, coreContent = coreSource(candidate.scripts)) {
    for (const file of coreFiles) writeFileSync(join(cwd, file), coreContent);
    writeFileSync(join(cwd, prepare), content);
    if (extra) { writeFileSync(join(cwd, extra), "untrusted\n"); git("add", "-N", extra); }
    writeFileSync(join(artifact, "update.patch"), execFileSync("git", ["diff", "--binary"], { cwd, encoding: "utf8" }));
    git("reset", "--hard", baseSha);
    if (extra) rmSync(join(cwd, extra), { force: true });
  }
  patch();
  writeFileSync(join(artifact, "update.json"), JSON.stringify(update));
  writeFileSync(join(artifact, "report.md"), "Full report\n");
  writeFileSync(join(artifact, "pr-body.md"), "Concise report\n");
  const calls: { command: string; args: string[] }[] = [];
  const comments: string[] = [];
  const logs: string[] = [];
  let hasPr = false;
  let beforePush: (() => void) | undefined;
  const env = { ...process.env, UPDATE_ARTIFACT_DIR: artifact, GH_REPO: "test/repo", GITHUB_RUN_ID: "789",
    GITHUB_SERVER_URL: "https://github.com", HAS_PR_TOKEN: "false" };
  const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    calls.push({ command, args });
    if (command === "gh") {
      if (args[0] === "pr" && args[1] === "list") return hasPr ? existingUrl : "";
      if (args[0] === "pr" && args[1] === "create") return createdUrl;
      if (args[0] === "pr" && args[1] === "comment") comments.push(readFileSync(args[args.indexOf("--body-file") + 1], "utf8"));
      if (args[0] === "api") return "engine-data\n";
      return "";
    }
    if (args.includes("push")) beforePush?.();
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe", env: options.env ?? env });
  };
  const publish = () => publishEngineData({ cwd, env, run, log: (message: string) => logs.push(message) });
  function branch(pins = old, author = bot) {
    git("switch", "-c", "chore/engine-data-update");
    writeFileSync(join(cwd, prepare), source(pins));
    for (const file of coreFiles) writeFileSync(join(cwd, file), coreSource(pins.scripts));
    git("add", prepare, ...coreFiles);
    git("-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--allow-empty", "-qm", "branch work");
    git("push", "origin", "chore/engine-data-update");
    const sha = git("rev-parse", "HEAD");
    git("switch", "main");
    return sha;
  }
  return { cwd, artifact, git, calls, comments, logs, env, publish, branch, patch, baseSha, update,
    setPr: () => { hasPr = true; }, setBeforePush: (fn: () => void) => { beforePush = fn; } };
}

const pushed = (f: ReturnType<typeof fixture>) => f.calls.filter((c) => c.command === "git" && c.args[0] === "push");
const dispatched = (f: ReturnType<typeof fixture>) => f.calls.filter((c) => c.command === "gh" && c.args[0] === "workflow");

describe("engine data publication", () => {
  it("requires an exact author identity without normalizing whitespace", () => {
    expect(hasHumanCommits(` ${bot.name}\0${bot.email}\n`)).toBe(true);
    expect(hasHumanCommits(`${bot.name}\0${bot.email} \n`)).toBe(true);
    expect(hasHumanCommits(`${bot.name}\0${bot.email}\n`)).toBe(false);
  });

  it.each([
    { name: "Human", email: bot.email },
    { name: bot.name, email: "human@example.invalid" },
  ])("protects any author that differs from the exact bot identity: $name / $email", async (author) => {
    const f = fixture(); f.branch(old, author); f.setPr();
    // A later bot commit must not conceal the human commit earlier in the branch.
    f.git("switch", "chore/engine-data-update");
    f.git("commit", "--allow-empty", "-qm", "later bot work");
    f.git("push", "origin", "chore/engine-data-update");
    f.git("switch", "main");
    expect(await f.publish()).toMatchObject({ status: "skipped", reason: "human-commits" });
    expect(f.logs).toContain("::warning::Engine data publication skipped: human-commits");
    expect(pushed(f)).toHaveLength(0); expect(dispatched(f)).toHaveLength(0);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]).toContain("https://github.com/test/repo/actions/runs/789");
  });

  it.each([old, next])("replaces human commits without an open PR, even with matching pins: %j", async (pins) => {
    const f = fixture();
    const stale = f.branch(pins, { name: "Human", email: "human@example.invalid" });
    expect(await f.publish()).toMatchObject({ status: "published", prUrl: createdUrl });
    expect(pushed(f)[0].args).toContain(`--force-with-lease=refs/heads/chore/engine-data-update:${stale}`);
    expect(f.git("rev-parse", "HEAD^")).toBe(f.baseSha);
    expect(f.comments).toHaveLength(0);
    expect(dispatched(f)).toHaveLength(1);
  });

  it("warns when the artifact is unchanged", async () => {
    const f = fixture();
    writeFileSync(join(f.artifact, "update.json"), JSON.stringify({ changed: false }));
    expect(await f.publish()).toMatchObject({ status: "skipped", reason: "unchanged" });
    expect(f.logs).toContain("::warning::Engine data publication skipped: unchanged");
    expect(pushed(f)).toHaveLength(0); expect(dispatched(f)).toHaveLength(0);
  });

  it("does not republish or dispatch identical pins on an open PR", async () => {
    const f = fixture(); f.branch(next); f.setPr();
    expect(await f.publish()).toMatchObject({ status: "skipped", reason: "identical-pins" });
    expect(f.logs).toContain("::warning::Engine data publication skipped: identical-pins");
    expect(pushed(f)).toHaveLength(0); expect(dispatched(f)).toHaveLength(0);
  });

  it("does not push or dispatch matching loaded data with different pins on the same open PR head", async () => {
    const f = fixture(); const head = f.branch(); f.setPr();
    writeFileSync(join(f.artifact, "update.json"), JSON.stringify({ ...f.update, matchingPrHead: head }));
    expect(await f.publish()).toMatchObject({ status: "skipped", reason: "identical-data" });
    expect(pushed(f)).toHaveLength(0); expect(dispatched(f)).toHaveLength(0);
    expect(f.git("rev-parse", "refs/remotes/origin/chore/engine-data-update")).toBe(head);
  });

  it.each(["stale-head", "no-pr", "human"])("keeps existing publication protections with a matching-data hint (%s)", async kind => {
    const f = fixture();
    const head = f.branch(old, kind === "human" ? { name: "Human", email: "human@example.invalid" } : bot);
    if (kind !== "no-pr") f.setPr();
    writeFileSync(join(f.artifact, "update.json"), JSON.stringify({ ...f.update,
      matchingPrHead: kind === "stale-head" ? "9".repeat(40) : head }));
    expect(await f.publish()).toMatchObject(kind === "human" ? { status: "skipped", reason: "human-commits" } : { status: "published" });
    expect(pushed(f)).toHaveLength(kind === "human" ? 0 : 1);
    expect(dispatched(f)).toHaveLength(kind === "human" ? 0 : 1);
    expect(f.comments).toHaveLength(kind === "human" ? 1 : 0);
  });

  it("rejects a stale artifact when the remote base advanced", async () => {
    const f = fixture(); f.git("commit", "--allow-empty", "-qm", "new base"); f.git("push", "origin", "main");
    expect(await f.publish()).toMatchObject({ status: "skipped", reason: "base-advanced" });
    expect(f.logs).toContain("::warning::Engine data publication skipped: base-advanced");
    expect(pushed(f)).toHaveLength(0); expect(dispatched(f)).toHaveLength(0);
  });

  it.each([false, true])("uses an explicit fetched lease (existing branch: %s) and exact bot attribution", async (exists) => {
    const f = fixture(); const expected = exists ? f.branch() : "";
    const result = await f.publish();
    expect(result).toMatchObject({ status: "published", prUrl: createdUrl });
    expect(pushed(f)[0].args).toContain(`--force-with-lease=refs/heads/chore/engine-data-update:${expected}`);
    expect(f.git("show", "refs/remotes/origin/chore/engine-data-update:" + prepare)).toBe(source(next).trim());
    const message = f.git("log", "-1", "--format=%B");
    expect(message).not.toMatch(/Claude|Co-Authored-By|Session/i);
    expect(f.git("log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(`${bot.name} <${bot.email}>|${bot.name} <${bot.email}>`);
    expect(f.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").sort()).toEqual([prepare, ...coreFiles].sort());
    for (const file of coreFiles) expect(f.git("show", `HEAD:${file}`)).toBe(coreSource(next.scripts).trim());
    expect(dispatched(f)[0].args).toEqual(["workflow", "run", "test.yml", "--repo", "test/repo", "--ref", "chore/engine-data-update", "-f", "nightly=false"]);
    // Newly created URL is used directly; a second PR listing could race eventual consistency.
    expect(f.calls.filter((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "list")).toHaveLength(1);
    expect(f.calls.some((c) => c.command === "gh" && c.args.includes(createdUrl) && c.args.includes("--add-label"))).toBe(true);
  });

  it("updates an existing PR and leaves dispatch to the personal/app token", async () => {
    const f = fixture(); f.branch(); f.setPr(); f.env.HAS_PR_TOKEN = "true";
    expect(await f.publish()).toMatchObject({ status: "published", prUrl: existingUrl });
    expect(dispatched(f)).toHaveLength(0);
    expect(f.calls.some((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "edit" && c.args.includes(existingUrl) && c.args.includes("--body-file"))).toBe(true);
  });

  it.each(["database", "strings"])("publishes a %s-only bump without changing core pin files", async (key) => {
    const candidate = { ...old, [key]: next[key as keyof typeof next] };
    const f = fixture(candidate);
    expect(await f.publish()).toMatchObject({ status: "published" });
    expect(f.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(prepare);
    for (const file of coreFiles) expect(f.git("show", `HEAD:${file}`)).toBe(coreSource(old.scripts).trim());
  });

  it.each(["extra-file", "code-edit", "reported-files", "file-mode", "core-edit", "missing-core-pin", "missing-reported-core", "invalid-matching-head"])("rejects an artifact with %s", async (kind) => {
    const f = fixture();
    if (kind === "core-edit") f.patch(source(next), undefined, coreSource(next.scripts).replace("1".repeat(40), "2".repeat(40)));
    if (kind === "missing-core-pin") f.patch(source(next), undefined, coreSource(old.scripts));
    if (kind === "missing-reported-core") writeFileSync(join(f.artifact, "update.json"), JSON.stringify({ ...f.update, files: [prepare] }));
    if (kind === "invalid-matching-head") writeFileSync(join(f.artifact, "update.json"), JSON.stringify({ ...f.update, matchingPrHead: "not-a-sha" }));
    if (kind === "extra-file") f.patch(source(next), "unauthorized.txt");
    if (kind === "code-edit") f.patch(source(next).replace("untouched", "changed"));
    if (kind === "reported-files") writeFileSync(join(f.artifact, "update.json"), JSON.stringify({ ...f.update, files: [prepare, "unauthorized.txt"] }));
    if (kind === "file-mode") {
      const patch = readFileSync(join(f.artifact, "update.patch"), "utf8").replace(/index ([^\n]+) 100644\n/, "old mode 100644\nnew mode 100755\nindex $1\n");
      writeFileSync(join(f.artifact, "update.patch"), patch);
    }
    await expect(f.publish()).rejects.toThrow(/patch|allowlist|pin|mode|matchingPrHead/i);
    expect(pushed(f)).toHaveLength(0); expect(dispatched(f)).toHaveLength(0);
    expect(f.git("status", "--porcelain")).toBe("");
  });

  it("rejects a concurrent branch change with the lease and never dispatches", async () => {
    const f = fixture(); f.branch();
    f.setBeforePush(() => {
      const oldHead = f.git("rev-parse", "refs/remotes/origin/chore/engine-data-update");
      const commit = execFileSync("git", ["commit-tree", `${oldHead}^{tree}`, "-p", oldHead, "-m", "concurrent change"], { cwd: f.cwd, encoding: "utf8" }).trim();
      f.git("push", "origin", `${commit}:refs/heads/chore/engine-data-update`);
    });
    await expect(f.publish()).rejects.toThrow();
    expect(dispatched(f)).toHaveLength(0);
    expect(f.calls.some((c) => c.command === "gh" && c.args[0] === "pr" && c.args[1] === "create")).toBe(false);
  });
});
