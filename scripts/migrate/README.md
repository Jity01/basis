# Basis Migration

Migrates old Basis data (`~/.context/`) to the new system (`~/context/`).

## What it does

1. Copies chunk data from `~/.context/` → `~/context/`
2. Copies settings (`ai-settings.json`, `chunk-settings.json`) → `~/.basis/`
3. Runs structured metadata extraction on every chunk (activities, entities, apps, intent)
4. Builds `catalog.json` per day (queryable chunk index)
5. Computes sessions per day with model-synthesized summaries
6. Builds user profile (`~/.basis/profile.json`)
7. Deletes old `~/.context/` directory

## Usage

```bash
pnpm build
node scripts/migrate/migrate.mjs

# Preview without changes
node scripts/migrate/migrate.mjs --dry-run
```

Requires `FIREWORKS_API_KEY` in your environment or saved in AI settings.
