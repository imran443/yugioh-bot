import { describe, expect, it, vi } from "vitest";
import { cardUpdate, renderCardUpdate, withPreviewExclusions, withCardUpdate, type CardSnapshot } from "../scripts/engine-data-card-report.js";
import { boundedReport } from "../scripts/engine-data-report.js";
import * as cardReport from "../scripts/engine-data-card-report.js";

const run = "https://github.com/example/repo/actions/runs/123";
const empty: CardSnapshot = { released: [], prerelease: [], remaps: {} };
const card = (code: number, name: string, file = "cards.cdb") => ({ code, name, file, type: 33 });
const metadata = [
  { id: 12, name: "API name", card_sets: [
    { set_name: "Unrelated reprint", set_code: "REPR-EN001" },
    { set_name: "Beyond the Brave", set_code: "BETB-EN001" },
    { set_name: "Beyond the Brave", set_code: "BETB-EN001" },
  ], card_images: [{ id: 12, image_url: "https://images.ygoprodeck.com/images/cards/12.jpg" }],
  misc_info: [{ tcg_date: "2026-10-08", ocg_date: "2026-07-18" }] },
  { id: 13, card_sets: [{ set_name: "Beyond the Brave", set_code: "BETB-EN002" }] },
  { id: 14, card_sets: [{ set_name: "Beyond the Brave", set_code: "BETB-EN003" }] },
];
const request = () => vi.fn(async (url: string | URL | Request) => String(url).includes("cardsets.php")
  ? Response.json([{ set_name: "Beyond the Brave", set_code: "BETB", tcg_date: "2026-10-08" }])
  : Response.json({ data: metadata }));

describe("released TCG sets still in upstream previews", () => {
  it("reports existing previews during a script-only update, deduplicating English set variants", async () => {
    const previews = { ...empty, prerelease: [card(101402090, "Angelechy", "prerelease-betb-en.cdb"),
      card(101402091, "Another card", "prerelease-betb.cdb")] };
    const fetchMetadata = request();
    const changes = await cardUpdate(previews, previews, fetchMetadata, "2026-10-10");
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
    const body = cardReport.renderReleasedSets(changes);
    expect(body).toContain("## Released TCG sets still in pre-release CDBs");
    expect(body).toContain("Beyond the Brave (BETB)");
    expect(body).toContain("TCG release: 2026-10-08; 2 cards");
    expect(body).toContain("prerelease-betb-en.cdb");
    expect(body).toContain("prerelease-betb.cdb");
    expect(body).toContain("still wait for Ignis");
    expect((body.match(/Beyond the Brave/g) ?? []).length).toBe(1);
  });
  it("uses product tcg_date, including today UTC, and ignores future, unknown and invalid dates", async () => {
    const fetchMetadata = vi.fn(async (url: string | URL | Request) => String(url).includes("cardsets.php") ? Response.json([
      { set_code: "TODAY", set_name: "Today set", tcg_date: "2026-10-10" },
      { set_code: "FUTURE", set_name: "Future set", tcg_date: "2026-10-11" },
      { set_code: "UNKNOWN", set_name: "Unknown date" },
      { set_code: "INVALID", set_name: "Invalid date", tcg_date: "2026-02-30" },
    ]) : Response.json({ data: [{ id: 2, misc_info: [{ tcg_date: "2025-01-01" }] }] }));
    const next = { ...empty, prerelease: ["today", "future", "unknown", "invalid"].map((set, i) => card(i + 1, set, `prerelease-${set}.cdb`)) };
    const body = cardReport.renderReleasedSets(await cardUpdate(empty, next, fetchMetadata, "2026-10-10"));
    expect(body).toContain("Today set (TODAY)");
    expect(body).not.toContain("Future set");
    expect(body).not.toContain("Unknown date");
    expect(body).not.toContain("Invalid date");
  });
  it("finds products for generic previews by explicit beta IDs and printing codes", async () => {
    const fetchMetadata = vi.fn(async (url: string | URL | Request) => String(url).includes("cardsets.php")
      ? Response.json([{ set_code: "BETB", set_name: "Beyond the Brave", tcg_date: "2026-10-08" }])
      : Response.json({ data: [{ id: 12, card_sets: [{ set_code: "BETB-EN090", set_name: "Beyond the Brave" }], misc_info: [{ beta_id: 101402090 }] }] }));
    const next = { ...empty, prerelease: [card(101402090, "Preview", "prerelease-others.cdb")] };
    expect(cardReport.renderReleasedSets(await cardUpdate(empty, next, fetchMetadata, "2026-10-10"))).toContain("Beyond the Brave (BETB)");
  });
  it("omits previews whose identity or passcode is also in released rows", async () => {
    const next = { ...empty, released: [card(1, "Same name"), card(2, "Same code")], prerelease: [
      card(100000001, " SAME NAME ", "prerelease-betb-en.cdb"), card(2, "Same code", "prerelease-betb.cdb"),
    ] };
    expect(cardReport.renderReleasedSets(await cardUpdate(empty, next, request(), "2026-10-10"))).toContain("No released TCG sets");
  });
  it("reports released-set metadata independently of an unavailable previous snapshot", async () => {
    const next = { ...empty, prerelease: [card(101402090, "Preview", "prerelease-betb-en.cdb")] };
    const changes = await cardUpdate(null, next, request(), "2026-10-10");
    expect(renderCardUpdate(changes)).toContain("could not be determined");
    expect(cardReport.renderReleasedSets(changes)).toContain("Beyond the Brave (BETB)");
  });
  it("labels a failed set lookup as unavailable, while a valid empty result says none", async () => {
    const next = { ...empty, prerelease: [card(101402090, "Preview", "prerelease-betb-en.cdb")] };
    const failed = vi.fn(async () => new Response("offline", { status: 503 }));
    const unavailable = cardReport.renderReleasedSets(await cardUpdate(empty, next, failed, "2026-10-10"));
    expect(unavailable).toContain("Released-set metadata unavailable");
    expect(unavailable).not.toContain("No released TCG sets");
    const blank = vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes("cardsets.php") ? [] : { data: [] }));
    expect(cardReport.renderReleasedSets(await cardUpdate(empty, next, blank, "2026-10-10"))).toContain("No released TCG sets");
  });
  it("escapes upstream set names and keeps the note in a bounded PR body", async () => {
    const fetchMetadata = vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes("cardsets.php")
      ? [{ set_code: "BETB", set_name: "Set <tag> @everyone | #123", tcg_date: "2026-10-08" }] : { data: [] }));
    const next = { ...empty, prerelease: [card(101402090, "Preview", "prerelease-betb-en.cdb")] };
    const note = cardReport.renderReleasedSets(await cardUpdate(empty, next, fetchMetadata, "2026-10-10"));
    expect(note).not.toContain("<tag>"); expect(note).not.toContain("@everyone"); expect(note).not.toContain("#123");
    const body = boundedReport("Needs review: 0\n" + "data\n".repeat(20000) + "\n" + note, run, 60000);
    expect(body).toContain("Released TCG sets still in pre-release CDBs");
    expect(body).toContain("BETB");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(60000);
  });
});

describe("weekly card additions", () => {
  it("uses HTML entities without Markdown backslashes inside summary labels", async () => {
    const metadata = vi.fn(async (url: string | URL | Request) => String(url).includes("cardsets.php")
      ? Response.json([{set_code:"BETB",set_name:'Set *bold* [name] \\ <tag> & @everyone #123'}]) : Response.json({data:[]}));
    const report = renderCardUpdate(await cardUpdate(empty,{...empty,released:[card(12,"Card","release-betb.cdb")]},metadata));
    const summary=report.match(/<summary>(.*?)<\/summary>/)![1]!;
    expect(summary).not.toContain("\\");
    expect(summary).toContain("&#42;bold&#42;");expect(summary).toContain("&#91;name&#93;");
    expect(summary).toContain("&#92;");expect(summary).toContain("&lt;tag&gt; &amp; &#64;everyone &#35;123");
  });
  it("groups by source product, joins English preview variants, and uses card_sets for base rows", async () => {
    const next = { ...empty, released: [card(12, "CDB name", "release-betb.cdb"), card(13, "Base addition")],
      prerelease: [card(100000014, "Preview", "prerelease-betb-en.cdb"), card(100000015, "Other preview", "prerelease-dbgv.cdb")] };
    const changes = await cardUpdate(empty, next, request());
    expect(changes.added.map(group => [group.code, group.cards.map(c => c.code)])).toEqual([
      ["BETB", [13, 12, 100000014]], ["DBGV", [100000015]],
    ]);
    const report = renderCardUpdate(changes);
    expect(report).toContain("Beyond the Brave (BETB)");
    expect(report).toContain("TCG release: 2026-10-08");
    expect(report).toContain("OCG first release: 2026-07-18");
    expect(report).toContain("CDB name");
    expect(report).not.toContain("API name");
    expect(report).toContain('src="https://images.ygoprodeck.com/images/cards/12.jpg" width=80');
    expect(report).toContain('src="https://pics.projectignis.org:2096/pics/100000014.jpg" width=80');
    expect(report).toContain("**pre-release**");
    expect((report.match(/<details>/g) ?? []).length).toBe(2);
    expect((report.match(/<\/details>/g) ?? []).length).toBe(2);
  });

  it.each(["throw", "http", "json", "shape"])("keeps CDB names and source sets when enrichment fails (%s)", async failure => {
    const failed = vi.fn(async () => {
      if (failure === "throw") throw new Error("offline");
      if (failure === "http") return new Response("unavailable", { status: 503 });
      if (failure === "json") return new Response("not json");
      return Response.json({ data: [null], nonsense: true });
    });
    const report = renderCardUpdate(await cardUpdate(empty, { ...empty,
      prerelease: [card(100000001, "CDB <name> @everyone", "prerelease-betb-en.cdb")],
      released: [card(12, "Offline official", "release-betb.cdb"), card(13, "Unknown set")],
    }, failed));
    expect(report).toContain("BETB");
    expect(report).toContain("CDB &lt;name&gt; &#64;everyone");
    expect(report).toContain("Unknown set");
    expect(report).toContain("metadata unavailable");
    expect(report).not.toContain("<name>");
  });

  it("reports removed cards and renamed or same-passcode graduations without calling them removals", async () => {
    const previous = { ...empty, released: [card(9, "Removed official")],
      prerelease: [card(100000001, "Old name"), card(15, "Same code"), card(100000002, "Withdrawn")] };
    const next = { ...empty, released: [card(12, "Official name", "release-betb.cdb"), card(15, "Same code")], remaps: { "100000001": 12 } };
    const changes = await cardUpdate(previous, next, request());
    expect(changes.removed.map(c => c.code)).toEqual([9, 100000002]);
    expect(changes.graduated.map(c => [c.oldCode, c.code])).toEqual([[15, 15], [100000001, 12]]);
    const report = renderCardUpdate(changes);
    expect(report).toContain("Removed cards (2)");
    expect(report).toContain("Graduated pre-release cards (2)");
    expect(report).toContain("100000001 → 12");
    expect(report).toContain("Old name");
    expect(report).toContain("Official name");
  });

  it("marks an unavailable previous snapshot and omits excluded preview additions after validation", async () => {
    const next = { ...empty, prerelease: [card(100000001, "Excluded", "prerelease-betb.cdb")], released: [card(12, "Healthy")] };
    expect(renderCardUpdate(await cardUpdate(null, next, request()))).toContain("could not be determined");
    const changes = await cardUpdate(empty, next, request());
    const filtered = withPreviewExclusions(changes, [100000001]);
    expect(renderCardUpdate(filtered)).not.toContain("Excluded");
    expect(renderCardUpdate(filtered)).toContain("Added cards: 1");
    expect(renderCardUpdate(changes)).toContain("Excluded");
  });

  it.each([false, true])("reports newly excluded existing previews as removals after smoke (other additions=%s)", async hasAddition => {
    const preview = card(100000001, "Previously available", "prerelease-betb.cdb");
    const previous = { ...empty, prerelease: [preview] };
    const next = { ...previous, released: hasAddition ? [card(12, "New official")] : [] };
    const changes = await cardUpdate(previous, next, request());
    // JSON round trip represents the deferred workflow's update.json metadata.
    const final = withPreviewExclusions(JSON.parse(JSON.stringify(changes)), [100000001]);
    expect(final.removed.map(card => card.code)).toEqual([100000001]);
    expect(renderCardUpdate(final)).toContain("Removed cards (1)");
    expect(renderCardUpdate(final)).toContain("Previously available");
    expect(changes.removed).toEqual([]);
    expect(withPreviewExclusions(final, [100000001]).removed).toEqual(final.removed);
  });

  it("preserves literal dollar replacement syntax in refreshed CDB names", async () => {
    const changes = await cardUpdate(empty, { ...empty, released: [card(12, "Card $& name")] }, request());
    const report = "Needs review: 0\n\n## New cards in this update\n\nPending.\n\n## Upstream commits\n\nCompare links.\n";
    const refreshed = withCardUpdate(report, changes);
    expect(refreshed).toContain("Card $&amp; name");
    expect(refreshed).not.toContain("Pending.");
    expect(refreshed).toContain("Compare links.");
  });

  it("keeps the full artifact and truncates complete card rows and closed details within the PR limit", async () => {
    const next = { ...empty, released: Array.from({ length: 2000 }, (_, i) => card(i + 1, `Card ${i} ${"漢".repeat(20)}`, i % 2 ? "release-betb.cdb" : "release-other.cdb")) };
    const cards = renderCardUpdate(await cardUpdate(empty, next, request()));
    const full = `Needs review: 0\n\n# Update\n\n${cards}\n## Changed scripts\n\n${"scripts\n".repeat(20000)}\n## Deployment\n\nLive-duel warning; replay loss.\n\n## Golden hashes\n\nRe-record hashes.\n`;
    const body = boundedReport(full, run, 60_000);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(60_000);
    expect(body.length).toBeLessThan(65536);
    expect(body).toContain("New cards in this update");
    expect(body).toMatch(/\d+ more, see the report artifact/);
    expect(body).toContain("replay loss");
    expect(body).toContain("Re-record hashes");
    expect(body).toContain(`${run}#artifacts`);
    expect(body).not.toContain("�");
    expect(body.match(/<details>/g)?.length).toBe(body.match(/<\/details>/g)?.length);
    expect(body.match(/<img /g)?.length).toBe(body.match(/width=80[^>]*>/g)?.length);
    const omitted = Number(/(\d+) more, see the report artifact/.exec(body)![1]);
    expect((body.match(/^- <img /gm) ?? []).length + omitted).toBe(2000);
    expect((full.match(/^- <img /gm) ?? []).length).toBe(2000);
  });
});
