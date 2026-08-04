require("dotenv").config();

const fs = require("fs");
const path = require("path");
const db = require("./db");

const DB_FILE = path.join(__dirname, "data", "submissions.json");

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.log("No data/submissions.json found — nothing to migrate.");
    return;
  }

  const list = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  await db.initSchema();

  let migrated = 0;
  let skipped = 0;

  for (const s of list) {
    const existing = await db.getSubmission(s.id);
    if (existing) {
      skipped++;
      continue;
    }
    await db.insertSubmission(s);
    migrated++;
  }

  console.log(`Migrated ${migrated} submission(s), skipped ${skipped} already in the database.`);
  await db.pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
