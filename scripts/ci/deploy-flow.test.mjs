import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const value = (expression, inputs, github, vars = {}) => Function("inputs", "github", "vars", `return (${expression
  .replace(/^\$\{\{\s*|\s*\}\}$/g, "")});`)(inputs, github, vars);

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function history(t) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-ref-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const runner = join(dir, "runner");
  git(dir, "init", "-b", "main", source);
  git(source, "config", "user.name", "Deploy test");
  git(source, "config", "user.email", "deploy-test@example.invalid");
  git(source, "commit", "--allow-empty", "-m", "main base");
  const base = git(source, "rev-parse", "HEAD");
  git(source, "switch", "-c", "unreviewed");
  git(source, "commit", "--allow-empty", "-m", "unreviewed code");
  const unreviewed = git(source, "rev-parse", "HEAD");
  git(source, "switch", "main");
  git(source, "commit", "--allow-empty", "-m", "main release");
  const release = git(source, "rev-parse", "HEAD");
  git(dir, "clone", source, runner);
  return { dir, runner, base, unreviewed, release };
}

test("production dispatch is manual and retains workflow safety when an older main SHA is selected", () => {
  const prod = workflow("deploy.yml");
  assert.deepEqual(Object.keys(prod.on), ["workflow_dispatch"]);
  assert.equal(prod.on.workflow_dispatch.inputs.ref.default, "main");
  assert.equal(prod.on.workflow_dispatch.inputs.force.default, false);
  assert.equal(prod.on.workflow_dispatch.inputs.rollback.default, false);
  const steps = prod.jobs.deploy.steps;
  const save = steps.findIndex(step => step.name === "Save deployment activity guard");
  const target = steps.findIndex(step => step.with?.ref === "${{ inputs.ref }}");
  assert.ok(save >= 0 && save < target, "preserve the guard before target checkout replaces the source files");
  assert.match(steps[save].run, /cp scripts\/deployment\/check-prod-activity.py "\$RUNNER_TEMP\/check-prod-activity.py"/);
  const remote = steps.find(step => step.name === "Deploy over SSH").run;
  assert.match(remote, /"\$RUNNER_TEMP\/check-prod-activity.py" "\$VM_USER@\$VM_HOST:\$remote_guard"/);
  assert.equal(remote.match(/python3 "\$DEPLOY_GUARD"/g).length, 2);
  assert.match(remote, /git merge-base --is-ancestor HEAD "\$DEPLOY_COMMIT"/);
  assert.match(remote, /Do not run compose up\. Run Deploy again\./);
});

test("staging push uses the exact pushed SHA with safe dispatch defaults", () => {
  const staging = workflow("deploy-staging.yml");
  assert.deepEqual(staging.on.push.branches, ["main"]);
  assert.equal(staging.jobs.staging.if, "github.ref == 'refs/heads/main' && (github.event_name != 'push' || vars.STAGING_AUTO_DEPLOY == '1')");
  for (const [event, ref, enabled, expected] of [
    ["push", "main", undefined, false], ["push", "main", "0", false], ["push", "main", "1", true],
    ["push", "feature", "1", false], ["workflow_dispatch", "main", undefined, true],
    ["workflow_dispatch", "feature", "1", false],
  ]) {
    assert.equal(value(staging.jobs.staging.if, {}, { event_name: event, ref: `refs/heads/${ref}` }, { STAGING_AUTO_DEPLOY: enabled }), expected);
  }
  const env = staging.jobs.staging.env;
  const pushed = { sha: "a".repeat(40) };
  assert.equal(value(env.INPUT_REF, {}, pushed), pushed.sha);
  assert.equal(value(env.INPUT_ACTION, {}, pushed), "deploy");
  assert.equal(value(env.INPUT_REFRESH_DB, {}, pushed), "false");
  const manual = { ref: "reviewed-branch", action: "stop", refresh_db: true };
  assert.equal(value(env.INPUT_REF, manual, pushed), manual.ref);
  assert.equal(value(env.INPUT_ACTION, manual, pushed), "stop");
  assert.equal(value(env.INPUT_REFRESH_DB, manual, pushed), "true");
});

test("manual staging refs cannot replace the workflow revision's remote safety entry script", () => {
  const job = workflow("deploy-staging.yml").jobs.staging;
  assert.equal(job.env.VM_SSH_PRIVATE_KEY, undefined);
  const steps = job.steps;
  assert.deepEqual(steps.filter(step => step.env?.VM_SSH_PRIVATE_KEY).map(step => step.name), ["Configure SSH key"]);
  const save = steps.findIndex(step => step.name === "Save staging deployment controls");
  const target = steps.findIndex(step => step.with?.ref === "${{ env.INPUT_REF }}");
  assert.ok(save >= 0 && save < target, "preserve staging controls before target checkout");
  assert.match(steps[save].run, /cp scripts\/staging\/remote-deploy.sh "\$RUNNER_TEMP\/staging-remote-deploy.sh"/);
  assert.match(steps[save].run, /cp scripts\/deployment\/check-prod-activity.py "\$RUNNER_TEMP\/staging-activity-guard.py"/);
  const transfer = steps.find(step => step.name === "Run on the VM").run;
  assert.match(transfer, /< "\$RUNNER_TEMP\/staging-remote-deploy.sh"/);
  assert.match(transfer, /STAGING_GUARD='\$remote_guard'/);
});

test("only manual staging dispatch can ignore production activity", () => {
  const staging = workflow("deploy-staging.yml");
  const input = staging.on.workflow_dispatch.inputs.ignore_prod_activity;
  assert.ok(input, "manual staging dispatch must provide ignore_prod_activity");
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  const expression = staging.jobs.staging.env.INPUT_IGNORE_PROD_ACTIVITY;
  for (const [event, enabled, expected] of [
    ["push", undefined, "false"], ["push", true, "false"],
    ["workflow_dispatch", undefined, "false"], ["workflow_dispatch", false, "false"],
    ["workflow_dispatch", true, "true"],
  ]) {
    assert.equal(value(expression, { ignore_prod_activity: enabled }, { event_name: event }), expected);
  }
  const steps = staging.jobs.staging.steps;
  assert.match(steps.find(step => step.name === "Check inputs and secrets").run,
    /check "ignore_prod_activity" "\$INPUT_IGNORE_PROD_ACTIVITY" '\^\(true\|false\)\$'/);
  assert.match(steps.find(step => step.name === "Run on the VM").run,
    /STAGING_IGNORE_PROD_ACTIVITY='\$INPUT_IGNORE_PROD_ACTIVITY'/);
});

test("selected production code runs only after its main ancestry check, without the SSH key", t => {
  const prod = workflow("deploy.yml");
  assert.equal(prod.jobs.deploy.env.VM_SSH_PRIVATE_KEY, undefined);
  const steps = prod.jobs.deploy.steps;
  const checkout = steps.findIndex(step => step.name === "Checkout deploy ref");
  assert.equal(steps[checkout].with["fetch-depth"], 0);
  const verify = steps[checkout + 1];
  assert.equal(verify.name, "Verify deploy ref is on main");
  assert.match(verify.run, /git fetch origin main && git merge-base --is-ancestor HEAD FETCH_HEAD/);
  const install = steps.find(step => step.name === "Install duel-engine build dependencies");
  const keyStep = steps.findIndex(step => step.name === "Configure SSH key");
  assert.ok(steps.indexOf(install) > checkout + 1 && keyStep > steps.indexOf(install));
  assert.deepEqual(steps.filter(step => step.env?.VM_SSH_PRIVATE_KEY).map(step => step.name), ["Configure SSH key"]);

  const { dir, runner, base, unreviewed, release } = history(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "build.log");
  for (const name of ["npm", "npx"]) {
    const path = join(bin, name);
    writeFileSync(path, '#!/bin/sh\n[ -z "${VM_SSH_PRIVATE_KEY+x}" ] || exit 99\necho "$*" >> "$TEST_LOG"\n');
    chmodSync(path, 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log };
  delete env.VM_SSH_PRIVATE_KEY;
  const runSelectedBuild = () => spawnSync("bash", ["-e", "-c", `${verify.run}\n${install.run}`], { cwd: runner, env, encoding: "utf8" });
  git(runner, "checkout", unreviewed);
  const refused = runSelectedBuild();
  assert.notEqual(refused.status, 0, refused.stderr);
  assert.equal(existsSync(log), false, "refused code must not reach npm or npx");
  for (const commit of [base, release]) {
    git(runner, "checkout", commit);
    const accepted = runSelectedBuild();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(readFileSync(log, "utf8"), /rebuild better-sqlite3/);
    rmSync(log);
  }
});

test("VM refuses older or diverged production commits unless rollback is explicit", t => {
  const remote = workflow("deploy.yml").jobs.deploy.steps.find(step => step.name === "Deploy over SSH").run;
  const start = remote.indexOf('git fetch origin "$DEPLOY_COMMIT"');
  const end = remote.indexOf("# Preflight, before anything on the VM changes", start);
  assert.ok(start > 0 && end > start);
  const { runner, base, unreviewed, release } = history(t);
  const run = (current, target, rollback) => {
    git(runner, "checkout", current);
    const result = spawnSync("sh", ["-e", "-c", remote.slice(start, end)], {
      cwd: runner, encoding: "utf8", env: { ...process.env, DEPLOY_COMMIT: target, DEPLOY_ROLLBACK: rollback },
    });
    assert.equal(git(runner, "rev-parse", "HEAD"), current, "ancestry checks must not change the checkout");
    return result;
  };
  for (const current of [release, unreviewed]) {
    const refused = run(current, base, "false");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Set rollback=true/);
    const rollback = run(current, base, "true");
    assert.equal(rollback.status, 0, rollback.stderr);
  }
  assert.equal(run(base, release, "false").status, 0);
  assert.equal(run(release, release, "false").status, 0);
  assert.notEqual(run(base, unreviewed, "true").status, 0, "rollback must still require a main commit");
});

test("second production guard refusal stops the deploy and gives recovery instructions", t => {
  const remote = workflow("deploy.yml").jobs.deploy.steps.find(step => step.name === "Deploy over SSH").run;
  const start = remote.indexOf('if ! python3 "$DEPLOY_GUARD"');
  const end = remote.indexOf("# Retire the bot container", start);
  assert.ok(start > 0 && end > start);
  const dir = mkdtempSync(join(tmpdir(), "second-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const guard = join(dir, "refuse.py");
  writeFileSync(guard, "raise SystemExit(1)\n");
  const result = spawnSync("sh", ["-e", "-c", `${remote.slice(start, end)}\necho reached-service-stop`], {
    encoding: "utf8", env: { ...process.env, DEPLOY_GUARD: guard, DEPLOY_FORCE: "false" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Do not run compose up\. Run Deploy again\./);
  assert.doesNotMatch(result.stdout, /reached-service-stop/);
});

test("staging warnings reach the step summary even when the VM step fails", t => {
  const steps = workflow("deploy-staging.yml").jobs.staging.steps;
  const transfer = steps.find(step => step.name === "Run on the VM");
  assert.match(transfer.run, /set -euo pipefail/);
  assert.match(transfer.run, /tee "\$RUNNER_TEMP\/staging-deploy.log"/);
  const report = steps.find(step => step.name === "Report staging result");
  assert.equal(report.if, "${{ always() }}");
  const dir = mkdtempSync(join(tmpdir(), "staging-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = join(dir, "summary.md");
  writeFileSync(join(dir, "staging-deploy.log"), "ordinary log\n::warning title=Staging skipped::skipping staging; production is active.\n");
  const result = spawnSync("bash", ["-e", "-c", report.run], { encoding: "utf8", env: { ...process.env, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(summary, "utf8"), /Staging skipped.*production is active/);
});
