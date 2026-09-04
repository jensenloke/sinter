# Ledger maintenance

Sinter keeps its session index and local metadata in a SQLite ledger. The
`sinter ledger` commands maintain that file without opening or changing native
harness stores.

## Backup

`sinter ledger backup` writes a consistent SQLite snapshot next to the ledger
with a UTC timestamp. Use `--output FILE` to choose a destination. Existing
files and symlinks are never overwritten. The snapshot is owner-readable on
supported platforms, and JSON output includes its byte count and SHA-256.
Backups are explicit; Sinter does not create one automatically before every
migration.

## Verify

`sinter ledger verify` runs SQLite integrity checks, checks the schema version
and expected tables, and checks that every session has exactly one corresponding
search-index row. It reports orphaned search rows and local metadata rows as
diagnostics. Verification is read-only.

## Repair

`sinter ledger repair --yes` takes a backup, rebuilds the derived FTS search
index, reindexes SQLite indexes, and reapplies the schema definition. Use
`--no-backup` only when an independently verified backup already exists.
Repair refuses to operate when SQLite reports file corruption.

Repair never deletes or edits session rows, aliases, pins, notes, tags,
lineage, saved views, or capsule replay records. It also never modifies native
harness stores.

## Restore

Stop Sinter, then copy a verified backup over the ledger path. Do not restore
while Sinter is running. Run `sinter ledger verify` after restarting Sinter to
confirm the restored ledger is healthy.
