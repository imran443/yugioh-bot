import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createDraftTemplateService } from "../../src/services/draft-templates.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return createDraftTemplateService(db);
}

describe("draft template service", () => {
  it("saves a template", () => {
    const templates = setup();

    const template = templates.save("guild-1", "Classic", { setNames: ["Metal Raiders"] }, "user-1");

    expect(template).toMatchObject({
      guildId: "guild-1",
      name: "Classic",
      config: { setNames: ["Metal Raiders"] },
      createdByUserId: "user-1",
    });
  });

  it("upserts an existing template by name", () => {
    const templates = setup();

    templates.save("guild-1", "Classic", { setNames: ["Metal Raiders"] }, "user-1");
    const updated = templates.save("guild-1", "Classic", { setNames: ["Legend of Blue Eyes White Dragon"] }, "user-2");

    expect(updated.config).toEqual({ setNames: ["Legend of Blue Eyes White Dragon"] });
    expect(updated.createdByUserId).toBe("user-2");
    expect(templates.list("guild-1")).toHaveLength(1);
  });

  it("lists templates ordered by name", () => {
    const templates = setup();

    templates.save("guild-1", "Zoo", { setNames: ["Zoodiac"] }, "user-1");
    templates.save("guild-1", "Alpha", { setNames: ["Alpha"] }, "user-1");
    templates.save("guild-1", "Beta", { setNames: ["Beta"] }, "user-1");

    const list = templates.list("guild-1");

    expect(list.map((t) => t.name)).toEqual(["Alpha", "Beta", "Zoo"]);
  });

  it("lists only templates for the requested guild", () => {
    const templates = setup();

    templates.save("guild-1", "Classic", { setNames: ["Metal Raiders"] }, "user-1");
    templates.save("guild-2", "Modern", { setNames: ["Duelist Nexus"] }, "user-1");

    expect(templates.list("guild-1")).toHaveLength(1);
    expect(templates.list("guild-1")[0].name).toBe("Classic");
    expect(templates.list("guild-2")).toHaveLength(1);
    expect(templates.list("guild-2")[0].name).toBe("Modern");
  });

  it("finds a template by name", () => {
    const templates = setup();

    templates.save("guild-1", "Classic", { setNames: ["Metal Raiders"] }, "user-1");

    expect(templates.findByName("guild-1", "Classic")?.config).toEqual({ setNames: ["Metal Raiders"] });
    expect(templates.findByName("guild-1", "Missing")).toBeUndefined();
    expect(templates.findByName("guild-2", "Classic")).toBeUndefined();
  });

  it("deletes a template", () => {
    const templates = setup();

    templates.save("guild-1", "Classic", { setNames: ["Metal Raiders"] }, "user-1");
    templates.delete("guild-1", "Classic");

    expect(templates.findByName("guild-1", "Classic")).toBeUndefined();
  });

  it("deleting a non-existent template does nothing", () => {
    const templates = setup();

    expect(() => templates.delete("guild-1", "Missing")).not.toThrow();
  });
});
