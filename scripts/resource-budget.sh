#!/bin/sh
# Idle resource budget for the dashboard and the agent.
#
#   scripts/resource-budget.sh [samples] [seconds-between]
#
# Samples `docker stats` for whichever of the containers below run on this
# host, averages CPU and takes the last memory reading, and exits 1 if any
# is over budget — run it on a quiet fleet before and after a change. The
# numbers come from the real fleet (README, "Resource budget"); raise one
# only with a reason in the commit.
#
# CPU is Docker's: percent of ONE core.

set -eu

SAMPLES=${1:-6}
GAP=${2:-5}

# name                 cpu%  MiB
BUDGET='
homelab-dashboard-api  10    200
homelab-dashboard      1     30
homelab-agent          4     120
'

present=$(docker ps --format '{{.Names}}')
names=$(echo "$BUDGET" | awk 'NF==3 {print $1}' | while read -r n; do
  echo "$present" | grep -qx "$n" && echo "$n"
done)

if [ -z "$names" ]; then
  echo "none of the budgeted containers run here" >&2
  exit 2
fi

i=0
: > /tmp/hl-budget.$$
while [ "$i" -lt "$SAMPLES" ]; do
  # shellcheck disable=SC2086
  docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' $names >> /tmp/hl-budget.$$
  i=$((i + 1))
  [ "$i" -lt "$SAMPLES" ] && sleep "$GAP"
done

echo "$BUDGET" | awk -v file=/tmp/hl-budget.$$ '
  NF==3 { cpu_max[$1] = $2 + 0; mem_max[$1] = $3 + 0 }
  END {
    while ((getline line < file) > 0) {
      split(line, f, " ")
      name = f[1]; cpu = f[2]; sub(/%/, "", cpu)
      mem = f[3]
      if (mem ~ /GiB$/) { sub(/GiB$/, "", mem); mem *= 1024 }
      else if (mem ~ /MiB$/) { sub(/MiB$/, "", mem) }
      else if (mem ~ /KiB$/) { sub(/KiB$/, "", mem); mem /= 1024 }
      # sub() leaves strings behind; + 0 makes the comparisons numeric.
      sum[name] += cpu + 0; n[name]++; last[name] = mem + 0
    }
    fail = 0
    for (name in n) {
      avg = sum[name] / n[name]
      over = (avg > cpu_max[name] || last[name] > mem_max[name])
      printf "%-24s cpu %5.1f%% (budget %s%%)  mem %6.1f MiB (budget %s)  %s\n",
        name, avg, cpu_max[name], last[name], mem_max[name], over ? "OVER" : "ok"
      if (over) fail = 1
    }
    exit fail
  }'
status=$?
rm -f /tmp/hl-budget.$$
exit $status
