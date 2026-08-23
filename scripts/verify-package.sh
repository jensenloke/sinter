#!/usr/bin/env bash
set -euo pipefail

package_dir="$(mktemp -d)"
bun_install_dir="$(mktemp -d)"
npm_install_dir="$(mktemp -d)"

cleanup() {
  rm -rf -- "$package_dir" "$bun_install_dir" "$npm_install_dir"
}
trap cleanup EXIT

if ! cmp -s LICENSE packages/cli/LICENSE; then
  echo "package license does not match the repository license" >&2
  exit 1
fi

npm pack --workspace packages/cli --pack-destination "$package_dir" >/dev/null
tarballs=("$package_dir"/*.tgz)
if [[ ${#tarballs[@]} -ne 1 || ! -f "${tarballs[0]}" ]]; then
  echo "expected exactly one package tarball" >&2
  exit 1
fi

contents="$(tar -tzf "${tarballs[0]}")"
for required in package/LICENSE package/README.md package/package.json package/dist/main.js; do
  if ! grep -qx "$required" <<<"$contents"; then
    echo "package tarball is missing $required" >&2
    exit 1
  fi
done

expected="$(bun -e 'import pkg from "./packages/cli/package.json"; process.stdout.write(pkg.version)')"

BUN_INSTALL="$bun_install_dir" bun add --global "${tarballs[0]}" >/dev/null
bun_installed="$bun_install_dir/bin/sinter"
bun_actual="$($bun_installed --version)"
if [[ "$bun_actual" != "$expected" ]]; then
  echo "Bun-installed CLI version $bun_actual does not match package version $expected" >&2
  exit 1
fi

"$bun_installed" completion bash | bash -n
snapshot="$($bun_installed watch recent --no-scan --json --ledger "$bun_install_dir/ledger.db" --no-update-check)"
SNAPSHOT="$snapshot" bun -e '
  const value = JSON.parse(process.env.SNAPSHOT ?? "null");
  if (value?.schema !== "sinter.watch.v1" || !Array.isArray(value.sessions)) process.exit(1);
'
capabilities="$($bun_installed capabilities --json --no-update-check)"
CAPABILITIES="$capabilities" bun -e '
  const value = JSON.parse(process.env.CAPABILITIES ?? "null");
  if (value?.schema !== "sinter.capabilities.v1" || value.capabilities?.length !== 7) process.exit(1);
'

npm install --global --prefix "$npm_install_dir" "${tarballs[0]}" >/dev/null
npm_actual="$("$npm_install_dir/bin/sinter" --version)"
if [[ "$npm_actual" != "$expected" ]]; then
  echo "npm-installed CLI version $npm_actual does not match package version $expected" >&2
  exit 1
fi

echo "verified Bun and npm global installs for @jensenloke/sinter@$expected"
