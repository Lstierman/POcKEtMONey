#!/usr/bin/env bash
# Downloads every open data source into build/sources (shallow clones, only the files the build reads).
set -euo pipefail
S="${1:-build/sources}"; mkdir -p "$S/probe"
clone() { # url dir paths...
  local url=$1 dir=$2; shift 2
  rm -rf "$dir"; git clone -q --depth 1 --filter=blob:none --no-checkout "$url" "$dir"
  git -C "$dir" checkout -q HEAD -- "$@"
}
clone https://github.com/PokemonTCG/pokemon-tcg-data.git "$S/repo" sets cards/en
clone https://github.com/psvanzyl/pokemon-tcg.git "$S/psv" public/data
clone https://github.com/kazant/pokedex-scanner-data.git "$S/probe/kazant_pokedex-scanner-data" latest history index.json
clone https://github.com/ZyzyThePizi/pokemon-price-data.git "$S/probe/ZyzyThePizi_pokemon-price-data" \
  prices/latest.json catalog/v2/cards-ja.json catalog/v2/sets.json catalog/pokedex.json history
clone https://github.com/Tbaker-maker/Catchem-data.git "$S/probe/Tbaker-maker_Catchem-data" data/history/tcgcsv-daily/raw
# the build reads psv data from $S/psv/public/data
echo "sources ready in $S"
