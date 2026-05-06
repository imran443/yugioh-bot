import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "dotenv";

type SnapshotCard = {
  ygoprodeckId: number;
  name: string;
  type: string;
  frameType: string;
  imageUrl: string;
  imageUrlSmall: string;
  cardSets: Array<{ set_name: string }>;
};

// Load .env from repo root so DISCORD_USER_ID / DISCORD_GUILD_ID are available
config({ path: join(process.cwd(), ".env") });

const dbPath = process.env.DATABASE_PATH ?? join(process.cwd(), "data", "bot.sqlite");
const userDiscordId = process.env.DISCORD_USER_ID ?? "123456789012345678";
const guildId = process.env.DISCORD_GUILD_ID ?? "987654321098765432";
const draftCatalogSnapshotPath = join(process.cwd(), "scripts", "data", "draft-catalog-legendary.json");
const draftCatalogSnapshot = JSON.parse(
  readFileSync(draftCatalogSnapshotPath, "utf8")
) as { cards: SnapshotCard[] };

mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  create table if not exists players (
    id integer primary key autoincrement,
    guild_id text not null,
    discord_user_id text not null,
    display_name text not null,
    created_at text not null default current_timestamp,
    unique (guild_id, discord_user_id)
  );

  create table if not exists tournaments (
    id integer primary key autoincrement,
    guild_id text not null,
    name text not null,
    format text not null,
    status text not null,
    created_by_user_id text not null,
    created_at text not null default current_timestamp,
    started_at text,
    ended_at text,
    web_slug text
  );

  create table if not exists tournament_participants (
    tournament_id integer not null references tournaments(id),
    player_id integer not null references players(id),
    joined_at text not null default current_timestamp,
    primary key (tournament_id, player_id)
  );

  create table if not exists tournament_matches (
    id integer primary key autoincrement,
    tournament_id integer not null references tournaments(id),
    match_id integer,
    player_one_id integer not null references players(id),
    player_two_id integer references players(id),
    round_number integer not null,
    status text not null,
    metadata_json text not null default '{}'
  );

  create table if not exists matches (
    id integer primary key autoincrement,
    guild_id text not null,
    player_one_id integer not null references players(id),
    player_two_id integer not null references players(id),
    winner_id integer references players(id),
    reporter_id integer not null references players(id),
    approver_id integer references players(id),
    status text not null,
    source text not null,
    tournament_id integer references tournaments(id),
    created_at text not null default current_timestamp,
    resolved_at text
  );

  create table if not exists drafts (
    id integer primary key autoincrement,
    guild_id text not null,
    channel_id text not null,
    name text not null,
    status text not null,
    created_by_user_id text not null,
    config_json text not null default '{}',
    current_wave_number integer not null default 0,
    current_pick_step integer not null default 0,
    pick_deadline_at text,
    status_message_id text,
    created_at text not null default current_timestamp,
    started_at text,
    ended_at text,
    web_slug text
  );

  create table if not exists draft_players (
    draft_id integer not null references drafts(id),
    player_id integer not null references players(id),
    pick_count integer not null default 0,
    finished_at text,
    seat_index integer,
    joined_at text not null default current_timestamp,
    primary key (draft_id, player_id)
  );

  create table if not exists card_catalog (
    ygoprodeck_id integer primary key not null,
    name text not null,
    type text not null,
    frame_type text not null,
    image_url text not null,
    image_url_small text not null,
    card_sets_json text not null,
    cached_at text not null
  );

  create table if not exists draft_packs (
    id integer primary key autoincrement,
    draft_id integer not null references drafts(id),
    pack_round integer not null,
    origin_seat_index integer not null,
    current_holder_seat_index integer not null,
    pass_direction integer not null,
    created_at text not null default current_timestamp,
    unique (draft_id, pack_round, origin_seat_index)
  );

  create table if not exists draft_cards (
    id integer primary key autoincrement,
    draft_id integer not null references drafts(id),
    wave_number integer not null,
    draft_pack_id integer references draft_packs(id),
    catalog_card_id integer not null references card_catalog(ygoprodeck_id),
    position integer,
    picked_by_player_id integer,
    picked_at text,
    created_at text not null default current_timestamp,
    unique (id, draft_id, wave_number)
  );

  create table if not exists draft_picks (
    id integer primary key autoincrement,
    draft_id integer not null references drafts(id),
    player_id integer not null,
    draft_card_id integer not null references draft_cards(id),
    wave_number integer not null,
    pick_step integer not null,
    pick_method text not null default 'manual',
    picked_at text not null,
    unique (draft_id, player_id, wave_number, pick_step),
    unique (draft_card_id)
  );

  create table if not exists draft_templates (
    id integer primary key autoincrement,
    guild_id text not null,
    name text not null,
    config_json text not null default '{}',
    created_by_user_id text not null,
    created_at text not null default current_timestamp,
    unique (guild_id, name)
  );

  create table if not exists card_sets (
    set_name text primary key not null,
    set_code text,
    card_count integer,
    synced_at text not null
  );

  create table if not exists guild_settings (
    guild_id text primary key not null,
    announce_draft_created integer not null default 1,
    announce_draft_started integer not null default 1,
    announce_draft_completed integer not null default 1,
    announce_tournament_created integer not null default 1,
    announce_tournament_completed integer not null default 1,
    announce_channel_id text
  );

  create index if not exists draft_cards_unpicked_by_draft_wave
    on draft_cards (draft_id, wave_number)
    where picked_by_player_id is null;

  create index if not exists draft_packs_holder_idx
    on draft_packs (draft_id, pack_round, current_holder_seat_index);

  create index if not exists draft_cards_pack_idx
    on draft_cards (draft_pack_id, picked_by_player_id, position);
`);

// ---------- CLEAN UP PREVIOUS SEED DATA FOR THIS GUILD ----------
db.exec(`
  delete from draft_picks where draft_id in (select id from drafts where guild_id = '${guildId}');
  delete from draft_cards where draft_id in (select id from drafts where guild_id = '${guildId}');
  delete from draft_packs where draft_id in (select id from drafts where guild_id = '${guildId}');
  delete from draft_players where draft_id in (select id from drafts where guild_id = '${guildId}');
  delete from drafts where guild_id = '${guildId}' and name in ('Legendary Draft', 'Retro Draft');
  delete from tournament_matches where tournament_id in (select id from tournaments where guild_id = '${guildId}' and name in ('Friday Night Fights', 'Weekend Championship'));
  delete from matches where guild_id = '${guildId}' and tournament_id in (select id from tournaments where guild_id = '${guildId}' and name in ('Friday Night Fights', 'Weekend Championship'));
  delete from tournament_participants where tournament_id in (select id from tournaments where guild_id = '${guildId}' and name in ('Friday Night Fights', 'Weekend Championship'));
  delete from tournaments where guild_id = '${guildId}' and name in ('Friday Night Fights', 'Weekend Championship');
  delete from players where guild_id = '${guildId}' and discord_user_id like 'fake_%';
  delete from card_catalog;
`);

// ---------- PLAYERS ----------
const playerNames = ["Yugi", "Kaiba", "Joey", "Pegasus"];
const insertPlayer = db.prepare(
  "insert or ignore into players (guild_id, discord_user_id, display_name) values (?, ?, ?)"
);

// First player = the logged-in user
insertPlayer.run(guildId, userDiscordId, "You");
playerNames.forEach((name) => {
  insertPlayer.run(guildId, `fake_${name.toLowerCase()}`, name);
});

const players = db
  .prepare("select id, discord_user_id, display_name from players where guild_id = ?")
  .all(guildId) as Array<{ id: number; discord_user_id: string; display_name: string }>;

const me = players.find((p) => p.discord_user_id === userDiscordId)!;
const others = players.filter((p) => p.discord_user_id !== userDiscordId);

// ---------- CARD CATALOG ----------
const insertCard = db.prepare(
  `insert into card_catalog
   (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
   values (?, ?, ?, ?, ?, ?, ?, datetime('now'))
   on conflict(ygoprodeck_id) do update set
     name = excluded.name,
     type = excluded.type,
     frame_type = excluded.frame_type,
     image_url = excluded.image_url,
     image_url_small = excluded.image_url_small,
     card_sets_json = excluded.card_sets_json,
     cached_at = excluded.cached_at`
);

draftCatalogSnapshot.cards.forEach((card) => {
  insertCard.run(
    card.ygoprodeckId,
    card.name,
    card.type,
    card.frameType,
    card.imageUrl,
    card.imageUrlSmall,
    JSON.stringify(card.cardSets)
  );
});

// ---------- TOURNAMENT 1: ACTIVE ----------
const t1 = db
  .prepare(
    `insert into tournaments (guild_id, name, format, status, created_by_user_id, started_at, web_slug)
     values (?, ?, ?, ?, ?, datetime('now'), ?)`
  )
  .run(guildId, "Friday Night Fights", "round_robin", "active", me.discord_user_id, "fnf-2026");
const t1Id = Number(t1.lastInsertRowid);

// participants
[me, ...others].forEach((p) => {
  db.prepare("insert or ignore into tournament_participants (tournament_id, player_id) values (?, ?)").run(t1Id, p.id);
});

// matches (round 1)
const matchPairs = [
  [me.id, others[0].id],
  [others[1].id, others[2].id],
];
matchPairs.forEach(([p1, p2], idx) => {
  const m = db
    .prepare(
      `insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source, tournament_id, resolved_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(guildId, p1, p2, p1, me.id, "completed", "tournament", t1Id);
  const mId = Number(m.lastInsertRowid);
  db.prepare(
    `insert into tournament_matches (tournament_id, match_id, player_one_id, player_two_id, round_number, status, metadata_json)
     values (?, ?, ?, ?, ?, ?, ?)`
  ).run(t1Id, mId, p1, p2, 1, "completed", "{}");
});

// open match (round 2)
db.prepare(
  `insert into tournament_matches (tournament_id, match_id, player_one_id, player_two_id, round_number, status, metadata_json)
   values (?, ?, ?, ?, ?, ?, ?)`
).run(t1Id, null, me.id, others[1].id, 2, "open", "{}");

// ---------- TOURNAMENT 2: PENDING ----------
const t2 = db
  .prepare(
    `insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug)
     values (?, ?, ?, ?, ?, ?)`
  )
  .run(guildId, "Weekend Championship", "single_elim", "pending", me.discord_user_id, "weekend-champ");
const t2Id = Number(t2.lastInsertRowid);

[me, ...others].forEach((p) => {
  db.prepare("insert or ignore into tournament_participants (tournament_id, player_id) values (?, ?)").run(t2Id, p.id);
});

// ---------- DRAFT 1: PENDING ----------
const d1 = db
  .prepare(
    `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, current_wave_number, current_pick_step, web_slug)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  .run(
    guildId,
    "draft-channel-1",
    "Legendary Draft",
    "pending",
    me.discord_user_id,
    JSON.stringify({
      pickSeconds: 60,
      packSize: 5,
      packsPerPlayer: 3,
      setNames: [
        "Legend of Blue Eyes White Dragon",
        "Metal Raiders",
        "Spell Ruler",
      ],
    }),
    0,
    0,
    "legendary-draft"
  );
const d1Id = Number(d1.lastInsertRowid);

[me, ...others].forEach((p, i) => {
  db.prepare(
    `insert into draft_players (draft_id, player_id, seat_index) values (?, ?, ?)`
  ).run(d1Id, p.id, i);
});

// ---------- DRAFT 2: COMPLETED ----------
const d2 = db
  .prepare(
    `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, current_wave_number, current_pick_step, started_at, ended_at, web_slug)
     values (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`
  )
  .run(
    guildId,
    "draft-channel-2",
    "Retro Draft",
    "completed",
    me.discord_user_id,
    JSON.stringify({
      pickSeconds: 45,
      packSize: 3,
      packsPerPlayer: 2,
      setNames: [
        "Legend of Blue Eyes White Dragon",
        "Metal Raiders",
        "Spell Ruler",
      ],
    }),
    2,
    6,
    "retro-draft"
  );
const d2Id = Number(d2.lastInsertRowid);

[me, ...others].forEach((p, i) => {
  db.prepare(`insert into draft_players (draft_id, player_id, seat_index, finished_at) values (?, ?, ?, datetime('now'))`).run(
    d2Id,
    p.id,
    i
  );
});

console.log("✅ Seed complete!");
console.log("");
console.log("Players created:", players.map((p) => `${p.display_name} (id=${p.id})`).join(", "));
console.log("");
console.log("Tournaments:");
console.log(`  Active:   http://localhost:3000/tournament/${t1Id}  (slug: fnf-2026)`);
console.log(`  Pending:  http://localhost:3000/tournament/${t2Id}  (slug: weekend-champ)`);
console.log(`  Standings: http://localhost:3000/tournament/${t1Id}/standings`);
console.log("");
console.log("Drafts:");
console.log(`  Active:    http://localhost:3000/draft/legendary-draft`);
console.log(`  Completed: http://localhost:3000/draft/retro-draft`);
console.log("");
console.log("Dashboard: http://localhost:3000/dashboard");
console.log("");
console.log(`If your Discord User ID is not ${userDiscordId}, set DISCORD_USER_ID=YOUR_ID before running this script.`);

process.exit(0);
