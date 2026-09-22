#!/usr/bin/env sh
# First-run setup for the dashboard: writes .env and starts it.
#
# Deliberately short. Only the handful of settings that decide whether the
# thing works at all are asked about; everything else has a default that's
# right for most people and lives in .env.example if you want it.
#
# Re-running is safe: every answer defaults to what's already there.

set -eu

cd "$(dirname "$0")"

ENV_FILE=.env
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

current() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

put() {
  tmp=$(mktemp)
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

ask() {
  key=$1; prompt=$2; default=${3:-}
  existing=$(current "$key")
  [ -n "$existing" ] && default=$existing

  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default"
  else
    printf '%s: ' "$prompt"
  fi

  read -r answer || answer=""
  [ -z "$answer" ] && answer=$default
  put "$key" "$answer"
}

confirm() {
  printf '%s [y/N]: ' "$1"
  read -r reply || reply=""
  case $reply in [yY]*) return 0 ;; *) return 1 ;; esac
}

secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

echo "homelab-dashboard setup"
echo

# ---- prerequisites --------------------------------------------------------

missing=""
command -v docker >/dev/null 2>&1 || missing="$missing docker"
[ -n "$missing" ] && { echo "Missing:$missing" >&2; exit 1; }

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker's compose plugin isn't available (try: docker compose version)." >&2
  exit 1
fi

# ---- Prometheus -----------------------------------------------------------
# The one dependency that fails silently. Host CPU, RAM, disk and
# temperature all come from here; without it you get containers and blank
# gauges, with nothing saying why.

ask PROMETHEUS_URL "Prometheus URL" "http://prometheus:9090"
PROM=$(current PROMETHEUS_URL)

if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 5 "$PROM/-/healthy" >/dev/null 2>&1 ||
     curl -fsS -m 5 "$PROM/api/v1/status/buildinfo" >/dev/null 2>&1; then
    echo "  Reachable."
  else
    echo "  Couldn't reach it from here."
    echo "  That may be fine — if Prometheus is a container on the same"
    echo "  Docker network, this name resolves inside the dashboard and not"
    echo "  out here. Worth checking if the gauges come up blank."
  fi
fi
echo

# ---- tokens ---------------------------------------------------------------

if [ -z "$(current API_TOKEN)" ]; then
  echo "API_TOKEN gates the routes that change things: deploying, and"
  echo "  telling a host to pull and rebuild. Without it, anything that can"
  echo "  reach the dashboard can do both."
  if confirm "  Generate one?"; then
    put API_TOKEN "$(secret)"
    echo "  Generated."
  fi
  echo
fi

if [ -z "$(current AGENT_TOKEN)" ]; then
  echo "AGENT_TOKEN is the shared secret the dashboard sends its agents."
  echo "  The same value goes in each agent's .env. Without it, anything"
  echo "  that can reach an agent's port can control its containers."
  if confirm "  Generate one?"; then
    put AGENT_TOKEN "$(secret)"
    echo "  Generated."
  fi
  echo
fi

# ---- alerting -------------------------------------------------------------

ask ALERT_WEBHOOK_URL "Alert webhook (blank for none — alerts still show in the UI)" \
  "$(current ALERT_WEBHOOK_URL)"
echo

# ---- done -----------------------------------------------------------------

echo "Wrote $ENV_FILE:"
sed 's/\(TOKEN=\).\{1,\}/\1***/' "$ENV_FILE" | sed 's/^/  /'
echo

if confirm "Start it now?"; then
  docker compose up -d --build
  echo
  echo "Dashboard is up. Add a node with:"
else
  echo "Start it with: docker compose up -d --build"
  echo
  echo "Then add a node with:"
fi

TOKEN=$(current API_TOKEN)
echo
echo "  curl -fsSL https://raw.githubusercontent.com/ZergFromZ0rg/homelab-agent/main/install.sh \\"
printf '    | sh -s -- --dashboard http://%s:8081' "$(hostname -s 2>/dev/null || hostname)"
[ -n "$TOKEN" ] && printf ' \\\n      --token %s' "$TOKEN"
printf ' \\\n      --rebuild\n'
echo
echo "  The Servers tab has the same command, with whatever address you"
echo "  actually reach the dashboard at."

if [ -n "$(current AGENT_TOKEN)" ]; then
  echo
  echo "  Each agent also needs AGENT_TOKEN=$(current AGENT_TOKEN) in its .env."
fi
