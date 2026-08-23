# Sinter capsule format v1

Status: implementation checkpoint, not yet a published compatibility promise.

Sinter capsules are encrypted, local-first files for carrying a coding-agent
conversation independently of a native harness store. Version 1 deliberately
supports context-only transfer. It does not package repositories, patches,
untracked files, tool artifacts, environment variables, credentials, or MCP
configuration.

## User contract

```sh
sinter bundle <session> --context-only -o handoff.sinter --passphrase-file key.txt
sinter inspect handoff.sinter --passphrase-file key.txt
sinter open handoff.sinter --in codex --passphrase-file key.txt
```

- `bundle` reads the best carry-forward SIF view and defaults to slim transfer,
  removing adapter-specific raw records before encryption.
- A secret-pattern review runs before any file is written. Findings are named
  by category without printing matched values. Writing then requires the
  explicit `--allow-sensitive` acknowledgement.
- `inspect` authenticates and decrypts the capsule, validates the embedded SIF,
  and shows what will be opened. It never invokes a harness writer.
- `open` creates a new target-native session. The source store and capsule are
  never modified, and historical tool calls remain inert unless the user
  explicitly passes `--live-tools`.
- Passphrases are read from a file so they do not appear in shell history or the
  process argument list. Version 1 requires at least 12 characters.
- Capsule writes refuse to overwrite an existing file unless `--force` is
  explicit. New files are created atomically with owner-only mode `0600`.

## Outer envelope

The UTF-8 `.sinter` file is JSON with this shape:

```json
{
  "format": "sinter-capsule",
  "version": 1,
  "protection": {
    "cipher": "aes-256-gcm",
    "kdf": "scrypt",
    "salt": "base64",
    "iv": "base64",
    "tag": "base64"
  },
  "payload": "base64 ciphertext"
}
```

The envelope contains no session metadata. AES-256-GCM authenticates the
ciphertext and the fixed `sinter-capsule:v1` associated-data string. Scrypt
derives the encryption key using N=32768, r=8, p=1 and a random 16-byte salt.
Every encryption uses a random 12-byte IV.

## Encrypted payload

The authenticated plaintext is JSON:

```json
{
  "format": "sinter-capsule-payload",
  "version": 1,
  "createdAt": "ISO-8601",
  "kind": "context-only",
  "transferMode": "slim",
  "session": "SIF session object"
}
```

The complete SIF remains inside the encrypted payload because origin identity,
cwd hints, timestamps, lineage, titles, and prompts can themselves be private.

## Threat model and limits

Version 1 protects a capsule copied through an untrusted storage or transport
channel when its passphrase is strong and sent separately. Authentication makes
wrong passphrases and file tampering fail closed.

It does not protect an unlocked device, a compromised Sinter process, a weak or
reused passphrase, a passphrase file sent beside the capsule, or content after a
target harness receives it. Pattern-based secret review reduces accidental
leakage but cannot prove a transcript contains no secrets; `inspect` and human
review remain required before sharing.

Workspace-aware capsules require a separate design: Git state collection,
explicit file allow-lists, symlink and traversal defenses, size limits, binary
handling, and stronger secret scanning. `--include-workspace` must fail until
those controls exist.

## Compatibility rules

- Readers reject unknown envelope or payload versions rather than guessing.
- Readers reject malformed base64, invalid parameter sizes, authentication
  failure, and invalid SIF.
- Writers never place plaintext metadata in the outer envelope.
- New optional payload fields may be added within version 1; changing crypto
  algorithms, KDF parameters, or required semantics requires a new version.
