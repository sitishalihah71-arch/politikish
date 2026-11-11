#!/bin/zsh
# Runs balance.mjs in parallel and merges. Usage: balance-par.sh <procs> <perCountPerProc> [extra balance.mjs args...]
# e.g. tools/sim/balance-par.sh 8 100 --set characters.populist.campaignTrust=15
cd "$(dirname "$0")/../.."
procs=$1; per=$2; shift 2
dir=$(mktemp -d)
for i in $(seq 1 $procs); do
  NODE_NO_WARNINGS=1 node tools/sim/balance.mjs --per $per --seed $((i * 1000000)) --out $dir/r$i.json "$@" > $dir/log$i.txt 2>&1 &
done
wait
grep -h "stuck" $dir/log*.txt | head -5
NODE_NO_WARNINGS=1 node tools/sim/balance.mjs --merge $dir/r*.json
