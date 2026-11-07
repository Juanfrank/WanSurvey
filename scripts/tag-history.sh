#!/usr/bin/env bash
# Creates the local tags of the reconstructed alpha history (0.1.0-alpha.1 to alpha.19),
# each on the commit listed in CHANGELOG.md, and optionally pushes them.
# Usage: scripts/tag-history.sh [--push]
set -euo pipefail

declare -A COMMITS=(
  [v0.1.0-alpha.1]=5fec66cdadfd298fc8525dd9b7ace19c47a8d56e
  [v0.1.0-alpha.2]=8e35b485ab79d6d4685f871bfeb210db47b9a373
  [v0.1.0-alpha.3]=9c3f4ef5fe12ab2253eda223670e38c34811851b
  [v0.1.0-alpha.4]=99b02b2238d8fd551d6c35a19f183e22456689bc
  [v0.1.0-alpha.5]=160074ea63536992e0533f59ca6d92bfbd64c698
  [v0.1.0-alpha.6]=bd00dc6e267e9dedc0bf737984881124c06ffb7e
  [v0.1.0-alpha.7]=49fd394d73f9eebc397badb49bced7ed4c38e31d
  [v0.1.0-alpha.8]=b25425457527d175a4eb84cc11e8aa19d1a1adb3
  [v0.1.0-alpha.9]=4ce31d9d6167dfd49f811c42cc0ff737f879d619
  [v0.1.0-alpha.10]=16718d77beb3f7ffa6c4ecbae3b09fa1daaeb10d
  [v0.1.0-alpha.11]=0baf186c08d83d4992d2dab1ad3807c4f6314996
  [v0.1.0-alpha.12]=4b20b8241998c984cecd1636abaf531762f5be10
  [v0.1.0-alpha.13]=21bc689a1225e3437c45cd36506ca4896b4b5772
  [v0.1.0-alpha.14]=1397089d4cec6cda336895eb8548c5e302ac130b
  [v0.1.0-alpha.15]=dab51330e82f4817b87dcc3222103b20cc6cde3f
  [v0.1.0-alpha.16]=158361d51f76cd31a1077943a4df94c68b83aba8
  [v0.1.0-alpha.17]=3f396361b02c1c8c41fbddea389f83f10e62fa70
  [v0.1.0-alpha.18]=761a9bb6d32483ab6ce4adc4e9d8b5763fabe634
  [v0.1.0-alpha.19]=10b69d317562cb41096b7ce2d2c23442e9149fcf
)

for t in $(printf "%s\n" "${!COMMITS[@]}" | sort -V); do
  c=${COMMITS[$t]}
  git cat-file -e "$c^{commit}" 2>/dev/null || { echo "missing commit $c for $t (fetch the whole branch first)" >&2; exit 1; }
  if git rev-parse -q --verify "refs/tags/$t" >/dev/null; then echo "$t exists"; else git tag -a "$t" "$c" -m "${t#v}"; echo "$t -> ${c:0:9}"; fi
done

if [ "${1:-}" = "--push" ]; then git push origin "${!COMMITS[@]}"; fi
