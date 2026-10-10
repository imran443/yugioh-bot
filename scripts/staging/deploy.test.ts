import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "@yugidraft/shared/db";

const root = resolve(import.meta.dirname, "../..");
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clerk-deploy-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe("production activity guard with the application schema", () => {
  it("accepts idle data and refuses active duels, RPS and dice openings", () => {
    const path = join(fixture(), "prod.sqlite");
    const db = openDatabase(path);
    try {
      db.prepare("INSERT INTO users (id, username, display_name) VALUES (1, 'owner', 'Owner')").run();
      db.prepare("INSERT INTO players (id, guild_id, user_id, display_name) VALUES (1, 'community', 1, 'Owner')").run();
      db.prepare("INSERT INTO duels (guild_id, web_slug, name, organizer_player_id, mode, status) VALUES ('community', 'test-duel', 'Test duel', 1, 'standard', 'lobby')").run();
      const guard = () => spawnSync("python3", ["-B", join(root, "scripts/deployment/check-prod-activity.py"), path], { encoding: "utf8" });
      expect(guard().status).toBe(0);
      for (const [status, opening] of [["active", null], ["lobby", '{"phase":"rps"}'], ["lobby", '{"phase":"dice"}']] as const) {
        db.prepare("UPDATE duels SET status = ?, opening_json = ?").run(status, opening);
        const result = guard();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toContain("duels=1");
      }
    } finally { db.close(); }
  });
});

describe("staging env", () => {
  function run(dir: string, clerk?: string) {
    const production = join(dir, "production.env");
    writeFileSync(production, "DISCORD_GUILD_ID=community\nDISCORD_TOKEN=old-token\nDISCORD_CLIENT_ID=old-client\nDISCORD_CLIENT_SECRET=old-secret\nNEXTAUTH_SECRET=old-auth\nCLERK_SECRET_KEY=sk_live_production\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_production\n");
    return spawnSync("sh", [join(root, "scripts/staging/make-staging-env.sh"), production, join(dir, "staging.env")], {
      encoding: "utf8",
      env: { ...process.env, STAGING_HOST: "staging.example.com", STAGING_CLERK_ENV: clerk ?? "" },
    });
  }

  it("requires a separate Clerk source and leaves no partial env", () => {
    const dir = fixture();
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STAGING_CLERK_ENV");
    expect(() => statSync(join(dir, "staging.env"))).toThrow();
  });

  it("copies only staging Clerk keys, scopes URLs, and generates private internal secrets", () => {
    const dir = fixture();
    const clerk = join(dir, "clerk.env");
    writeFileSync(clerk, "CLERK_SECRET_KEY=sk_live_separate_staging\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_separate_staging\n");
    const result = run(dir, clerk);
    expect(result.status).toBe(0);
    const output = readFileSync(join(dir, "staging.env"), "utf8");
    expect(output).toContain("CLERK_SECRET_KEY=sk_live_separate_staging\n");
    expect(output).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_separate_staging\n");
    expect(output).toContain("WEB_URL=http://staging.example.com:8080\n");
    expect(output).toContain("DISCORD_GUILD_ID=community\n");
    expect(output).toContain("DISCORD_BOT_ENABLED=0\n");
    expect(output).toMatch(/WS_INTERNAL_SECRET=[0-9a-f]{64}\n/);
    expect(output).toMatch(/DUEL_INTERNAL_SECRET=[0-9a-f]{64}\n/);
    expect(output).not.toMatch(/NEXTAUTH_|AUTH_URL|DISCORD_TOKEN|DISCORD_CLIENT_|BOT_ANNOUNCE_|production/);
    expect(statSync(join(dir, "staging.env")).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain("sk_live_separate_staging");
    expect(readFileSync(clerk, "utf8")).toContain("sk_live_separate_staging");
  });

  it("refuses to use the production env as its Clerk source", () => {
    const dir = fixture();
    const result = run(dir, join(dir, "production.env"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("separate");
  });

  it("requires both Clerk keys before replacing an existing staging env", () => {
    const dir = fixture();
    const production = join(dir, "production.env");
    const clerk = join(dir, "clerk.env");
    const output = join(dir, "staging.env");
    writeFileSync(production, "DISCORD_GUILD_ID=community\n");
    writeFileSync(clerk, "CLERK_SECRET_KEY=sk_live_staging\n");
    writeFileSync(output, "keep-me\n");
    const result = spawnSync("sh", [join(root, "scripts/staging/make-staging-env.sh"), "--force", production, output], {
      encoding: "utf8", env: { ...process.env, STAGING_HOST: "staging.example.com", STAGING_CLERK_ENV: clerk },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(readFileSync(output, "utf8")).toBe("keep-me\n");
  });

  it("refuses dev Clerk keys in staging", () => {
    const dir = fixture();
    const clerk = join(dir, "clerk.env");
    writeFileSync(clerk, "CLERK_SECRET_KEY=sk_test_development\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_development\n");
    const result = run(dir, clerk);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("staging instance");
    expect(() => statSync(join(dir, "staging.env"))).toThrow();
  });
});

describe("anonymous auth health checks", () => {
  function run(kind: "smoke" | "staging", status: string, body: string, sessionStatus = "200") {
    const dir = fixture();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // No sockets: these executables model HTTP responses and healthy container state.
    writeFileSync(join(bin, "curl"), `#!/bin/sh
url=""
output=""
format=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift ;;
    -w) format=$2; shift ;;
    http*) url=$1 ;;
  esac
  shift
done
case "$url" in
  */sign-in) code="$SIGNIN_STATUS"; body=sign-in ;;
  */api/auth/session) code="$SESSION_STATUS"; body="$SESSION_BODY" ;;
  */socket.io/*) code=200; body='0{"sid":"offline"}' ;;
  *smoke*) code=308; body="" ;;
  *) code=200; body="" ;;
esac
if [ -n "$output" ]; then printf '%s' "$body" > "$output"; fi
if [ -n "$format" ]; then
  case "$format" in
    *redirect_url*) printf '308 https://app.example.com/smoke?x=1' ;;
    *) printf '%s' "$code" ;;
  esac
elif [ -z "$output" ]; then printf '%s' "$body"; fi
`);
    writeFileSync(join(bin, "docker"), "#!/bin/sh\ncase \"$*\" in *Health*) echo healthy ;; *) echo 'running 0' ;; esac\n");
    chmodSync(join(bin, "curl"), 0o755);
    chmodSync(join(bin, "docker"), 0o755);
    let script = join(root, "scripts/smoke-test-site.sh");
    let args = ["app.example.com"];
    if (kind === "staging") {
      mkdirSync(join(dir, "scripts/staging"), { recursive: true });
      script = join(dir, "scripts/staging/health-check.sh");
      copyFileSync(join(root, "scripts/staging/health-check.sh"), script);
      writeFileSync(join(dir, "scripts/staging/compose.sh"), "#!/bin/sh\necho offline-container\n");
      writeFileSync(join(dir, ".env.staging"), "STAGING_HTTP_PORT=8080\n");
      args = ["0"];
    }
    return spawnSync("bash", [script, ...args], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SIGNIN_STATUS: status, SESSION_STATUS: sessionStatus, SESSION_BODY: body },
    });
  }
  for (const kind of ["smoke", "staging"] as const) {
    it(`${kind} accepts only a 200 sign-in page and a 200 null session`, () => {
      expect(run(kind, "200", "null").status).toBe(0);
      expect(run(kind, "302", "null").status).toBe(1);
      expect(run(kind, "200", '{"user":{"id":"1"}}').status).toBe(1);
      expect(run(kind, "200", "{broken-json").status).toBe(1);
      expect(run(kind, "200", "null", "503").status).toBe(1);
    });
  }
});

describe("staging database identity isolation", () => {
  it("clears copied Clerk bindings before startup, preserves gameplay IDs and keeps existing staging bindings", () => {
    const script = readFileSync(join(root, "scripts/staging/remote-deploy.sh"), "utf8");
    const migration = script.match(/worker node --input-type=module -e '\n([\s\S]*?)\n'/)?.[1];
    expect(migration).toBeTruthy();
    const dir = fixture();
    const path = join(dir, "copy.sqlite");
    let db = openDatabase(path);
    db.prepare("INSERT INTO users (id, clerk_user_id, username, display_name, synced_at) VALUES (123, 'user_production', 'imported', 'Imported', '2026-10-06T00:00:00Z')").run();
    db.prepare("INSERT INTO players (id, guild_id, user_id, discord_user_id, display_name) VALUES (456, 'community', 123, NULL, 'Imported')").run();
    db.close();
    function migrate(copied: string) {
      return spawnSync(process.execPath, ["--input-type=module", "-e", migration!], {
        encoding: "utf8", cwd: root, env: { ...process.env, DATABASE_PATH: path, STAGING_COPIED_DB: copied },
      });
    }
    const copied = migrate("1");
    expect(copied.status, copied.stderr).toBe(0);
    db = openDatabase(path);
    expect(db.prepare("SELECT id, clerk_user_id, synced_at FROM users WHERE id = 123").get()).toEqual({ id: 123, clerk_user_id: null, synced_at: null });
    expect(db.prepare("SELECT id, user_id FROM players WHERE id = 456").get()).toEqual({ id: 456, user_id: 123 });
    db.prepare("UPDATE users SET clerk_user_id = 'user_staging', synced_at = '2026-10-06T01:00:00Z' WHERE id = 123").run();
    db.close();
    const kept = migrate("0");
    expect(kept.status, kept.stderr).toBe(0);
    db = openDatabase(path);
    expect(db.prepare("SELECT clerk_user_id FROM users WHERE id = 123").get()).toEqual({ clerk_user_id: "user_staging" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
