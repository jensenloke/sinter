#!/usr/bin/env bash
set -euo pipefail

package_dir="$(mktemp -d)"
install_dir="$(mktemp -d)"

cleanup() {
  rm -rf -- "$package_dir" "$install_dir"
}
trap cleanup EXIT

npm pack --workspace packages/cli --pack-destination "$package_dir" >/dev/null
tarballs=("$package_dir"/*.tgz)
if [[ ${#tarballs[@]} -ne 1 || ! -f "${tarballs[0]}" ]]; then
  echo "expected exactly one package tarball" >&2
  exit 1
fi

BUN_INSTALL="$install_dir" bun add --global "${tarballs[0]}" >/dev/null
installed="$install_dir/bin/sinter"
expected="$(bun -e 'import pkg from "./packages/cli/package.json"; process.stdout.write(pkg.version)')"
actual="$($installed --version)"
if [[ "$actual" != "$expected" ]]; then
  echo "installed CLI version $actual does not match package version $expected" >&2
  exit 1
fi

"$installed" completion bash | bash -n
snapshot="$($installed watch recent --no-scan --json --ledger "$install_dir/ledger.db" --no-update-check)"
SNAPSHOT="$snapshot" bun -e '
  const value = JSON.parse(process.env.SNAPSHOT ?? "null");
  if (value?.schema !== "sinter.watch.v1" || !Array.isArray(value.sessions)) process.exit(1);
'

echo "verified globally installed @jensenloke/sinter@$actual"
