import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function setup() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-templates-id-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare("insert into draft_templates (guild_id, name, config_json, created_by_user_id) values ('guild-1','Alpha', ?, 'u')")
    .run(JSON.stringify({ setNames: ["Metal Raiders"], customCardIds: [1] }));
  db.prepare("insert into draft_templates (guild_id, name, config_json, created_by_user_id) values ('guild-1','Beta', ?, 'u')")
    .run(JSON.stringify({ setNames: [], customCardIds: [2] }));
  db.prepare("insert into draft_templates (guild_id, name, config_json, created_by_user_id) values ('guild-2','Gamma', ?, 'u')")
    .run(JSON.stringify({ setNames: [], customCardIds: [3] }));
  db.close();
}
function idOf(name: string): Promise<number> {
  return (async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(process.env.DATABASE_PATH!);
    const row = db.prepare("select id from draft_templates where name = ?").get(name) as { id: number };
    db.close();
    return row.id;
  })();
}

describe("/api/draft-templates/[id]", () => {
  beforeEach(() => { vi.resetModules(); auth.mockReset(); auth.mockResolvedValue({ user: { id: "u", name: "Yugi" } }); });
  afterEach(() => {
    delete process.env.DATABASE_PATH; delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("PUT updates name and pool", async () => {
    await setup();
    const id = await idOf("Alpha");
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(
      new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alpha Prime", setNames: ["Pharaonic Guardian"], customCardIds: [9, 10] }) }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.template).toMatchObject({ name: "Alpha Prime", setNames: ["Pharaonic Guardian"], customCardIds: [9, 10] });
  });

  it("PUT allows saving an empty pool with a unique title", async () => {
    await setup();
    const id = await idOf("Alpha");
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(
      new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alpha Empty", setNames: [], customCardIds: [] }) }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.template).toMatchObject({ name: "Alpha Empty", setNames: [], customCardIds: [] });
  });

  it("PUT 409 on name collision with a different template", async () => {
    await setup();
    const id = await idOf("Alpha");
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(
      new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Beta", setNames: [], customCardIds: [1] }) }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(res.status).toBe(409);
  });

  it("PUT 401 unauthenticated", async () => {
    await setup();
    const id = await idOf("Alpha");
    auth.mockResolvedValue(null);
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", body: JSON.stringify({}) }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(401);
  });

  it("PUT 404 for another guild's template", async () => {
    await setup();
    const id = await idOf("Gamma");
    const { PUT } = await import("../app/api/draft-templates/[id]/route");
    const res = await PUT(new Request(`http://localhost/api/draft-templates/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Gamma2", setNames: [], customCardIds: [1] }) }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(404);
  });

  it("DELETE removes the template; 404 on already-gone", async () => {
    await setup();
    const id = await idOf("Beta");
    const { DELETE } = await import("../app/api/draft-templates/[id]/route");
    const ok = await DELETE(new Request(`http://localhost/api/draft-templates/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(id) }) });
    expect(ok.status).toBe(200);
    const gone = await DELETE(new Request(`http://localhost/api/draft-templates/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(id) }) });
    expect(gone.status).toBe(404);
  });

  it("DELETE 404 for another guild's template", async () => {
    await setup();
    const id = await idOf("Gamma");
    const { DELETE } = await import("../app/api/draft-templates/[id]/route");
    const res = await DELETE(new Request(`http://localhost/api/draft-templates/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(404);
  });
});
