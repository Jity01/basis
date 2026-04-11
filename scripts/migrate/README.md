# Basis Migration

Migrates old Basis data (`~/.context/`) to the new system (`~/context/`).

**Non-destructive.** The original `~/.context/` directory is left untouched. Verify the migration, then delete it manually when you're ready.

## What it does

1. **Copies** chunk data from `~/.context/` → `~/context/`
2. **Copies** settings (`ai-settings.json`, `chunk-settings.json`) → `~/.basis/`
3. **Backfills** per-chunk `summary.txt` from legacy day-level `index.txt`
4. Runs **structured metadata extraction** on every chunk (activities, entities, apps, intent) via Fireworks
5. Builds **`catalog.json`** per day (queryable chunk index)
6. Rebuilds **SQLite index** (`~/context/index.db`)
7. Computes **sessions** per day with model-synthesized summaries
8. Builds **user profile** (`~/.basis/profile.json`)
9. Writes **rolling context** (`~/context/context.json`)

## Usage

```bash
pnpm build
node scripts/migrate/migrate.mjs

# Preview without changes
node scripts/migrate/migrate.mjs --dry-run
```

Requires `FIREWORKS_API_KEY` in your environment or saved in AI settings.

## After migration

Verify the new data:
```bash
ls ~/context/            # Should contain YYYY/ directories, index.db, context.json
ls ~/.basis/             # Should contain ai-settings.json, profile.json, etc.
```

Once satisfied, remove the old directory:
```bash
rm -rf ~/.context
```
