#!/usr/bin/env bash
# Life Web Cloud: install it, or update it, on Ubuntu (22.04 or newer) with one command:
#
#     curl -fsSL https://<your site>/lifeweb-install | bash
#
# What it does (it asks two questions the first time, and your password when it needs sudo):
#   1. installs Docker if it isn't there
#   2. gets the server (from GitHub) into ~/life-web; your settings (.env), boards (data/) and Tailscale sign-in (funnel/) stay
#   3. the first time: asks your name and what to call the server, and makes a new access code
#   4. starts the server, and puts it on the internet through Tailscale Funnel: it shows a Tailscale sign-in link (and, on a new
#      Tailscale account, a link to switch Funnel on); you click them, and the server gets its public https address
#   5. prints a connection link for Life Web (paste it in File › Connections) and a connector link for Claude (paste it in
#      Claude › Settings › Connectors), and keeps both in ~/life-web/CONNECT.txt
# Run it again any time to update; nothing of yours is lost. LIFEWEB_PUBLIC=0 keeps the server on your own network only;
# LIFEWEB_DIR, PORT and LIFEWEB_NAME (the container) can be set for a second server beside the first.
set -euo pipefail

REPO="${LIFEWEB_REPO:-B-Kpr/lifeweb-server}"           # where the server comes from ("owner/name" on GitHub)
DIR="${LIFEWEB_DIR:-$HOME/life-web}"
PUBLIC="${LIFEWEB_PUBLIC:-1}"
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
ask()  { local q="$1" def="${2:-}" a=""; if [ -r /dev/tty ]; then read -r -p "  $q${def:+ [$def]}: " a </dev/tty || true; fi; echo "${a:-$def}"; }
setenv() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
getenv() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

[ "$(uname -s)" = Linux ] || { echo "This is for an Ubuntu server."; exit 1; }
command -v sudo >/dev/null 2>&1 || { echo "This needs sudo."; exit 1; }

# 1. Docker
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  say "Installing Docker (a minute or two)…"
  sudo apt-get update -y
  sudo apt-get install -y docker.io docker-compose-v2 curl ca-certificates || sudo apt-get install -y docker.io docker-compose-plugin curl ca-certificates
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER" || true   # from your next sign-in, docker works without sudo
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# 2. the server's files (a copy next to this script, when it's run from one; otherwise the latest from GitHub)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
# a copy run from its own folder installs there (unless LIFEWEB_DIR says otherwise); the one-line command installs into ~/life-web
if [ -z "${LIFEWEB_DIR:-}" ] && [ -f "$HERE/compose.yaml" ] && [ -d "$HERE/src" ]; then DIR="$HERE"; fi
mkdir -p "$DIR"
if [ -f "$HERE/compose.yaml" ] && [ -d "$HERE/src" ]; then SRC="$HERE"
else
  [[ "$REPO" == *__LIFEWEB_REPO__* ]] && { echo "No server to download: set LIFEWEB_REPO=owner/name."; exit 1; }
  say "Getting Life Web Cloud…"
  SRC="$(mktemp -d)"; trap 'rm -rf "$SRC"' EXIT
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar xz --strip-components=1 -C "$SRC"
fi
if [ "$SRC" != "$DIR" ]; then
  rm -rf "$DIR/src"
  cp -r "$SRC/src" "$DIR/"
  for f in Dockerfile compose.yaml compose.funnel.yaml package.json .env.example install.sh; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DIR/"; done
fi
cd "$DIR"

# 3. settings, the first time
FIRST=0
if [ ! -f .env ]; then
  FIRST=1
  say "First-time setup"
  OWNER=$(ask "Your name (it shows in History and Chats)" "$(getent passwd "$USER" | cut -d: -f5 | cut -d, -f1 | awk '{print $1}')")
  OWNER=${OWNER:-Owner}
  NAME=$(ask "A name for this server (its web address starts with it)" "lifewebservice")
  NAME=$(echo "$NAME" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-' ); NAME=${NAME:-lifewebservice}
  TOKEN=$(head -c 33 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
  ( umask 077; cat > .env <<ENV
# Life Web Cloud settings (see .env.example). Keep this file private: the access code opens every board.
LIFEWEB_TOKEN=$TOKEN
LIFEWEB_ADMIN=$OWNER
LIFEWEB_LMSTUDIO=
PORT=${PORT:-3095}
LIFEWEB_NAME=${LIFEWEB_NAME:-life-web}
LIFEWEB_HOSTNAME=$NAME
LIFEWEB_PUBLIC_URL=
ENV
  )
  [ "$PUBLIC" = 1 ] && setenv COMPOSE_FILE compose.yaml:compose.funnel.yaml
fi
TOKEN=$(getenv LIFEWEB_TOKEN); PORT=$(getenv PORT); PORT=${PORT:-3095}
grep -q '^LIFEWEB_TOKEN=.\{24,\}' .env || { echo ".env has no LIFEWEB_TOKEN of 24 or more characters. Fix it and run this again."; exit 1; }

# 4. start it (the server runs as the "node" user, id 1000, so it must own data/)
mkdir -p data funnel/state
[ "$(stat -c %u data)" = 1000 ] || sudo chown -R 1000:1000 data
say "Starting Life Web Cloud…"
$DOCKER compose up -d --build
for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || { say "The server didn't start. Its log:"; $DOCKER logs --tail 40 "$(getenv LIFEWEB_NAME)"; exit 1; }
note "Running."

# the public address: Tailscale Funnel, in its own container. Its links (sign in; switch Funnel on) are shown as they come up.
ADDR=""
if grep -q '^COMPOSE_FILE=.*compose.funnel.yaml' .env; then
  say "Putting it on the internet (Tailscale)…"
  shown=""; up=0
  for i in $(seq 1 600); do
    for link in $($DOCKER logs life-web-funnel 2>&1 | grep -o 'https://login\.tailscale\.com/[^ "]*' | awk '!seen[$0]++'); do
      case " $shown " in *" $link "*) ;; *)
        shown="$shown $link"
        if [[ "$link" == */f/funnel* ]]; then note "Tailscale needs Funnel switched on for your account once. Open this link and click Enable:"
        else note "Open this link and sign in to Tailscale (make a free account if you don't have one), then click Connect:"; fi
        printf '\n      \033[1;36m%s\033[0m\n\n' "$link"; note "(waiting for you…)";;
      esac
    done
    # read the whole status first: "| grep -q" stops reading at the first match, which (with pipefail) counts as a failure
    st=$($DOCKER exec life-web-funnel tailscale funnel status 2>/dev/null || true)
    if [[ "$st" == *"Funnel on"* ]]; then up=1; break; fi
    sleep 2
  done
  [ "$up" = 1 ] || { say "Tailscale isn't on yet. Run this again when you've clicked the links."; exit 1; }
  js=$($DOCKER exec life-web-funnel tailscale status --json 2>/dev/null || true)
  DNS=$(printf '%s\n' "$js" | grep -o '"DNSName": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/; s/\.$//' || true)
  [ -n "$DNS" ] || { say "Couldn't read the server's Tailscale address. Run this again in a minute."; exit 1; }
  ADDR="https://$DNS"
  if [ "$(getenv LIFEWEB_PUBLIC_URL)" != "$ADDR" ]; then setenv LIFEWEB_PUBLIC_URL "$ADDR"; $DOCKER compose up -d >/dev/null 2>&1; fi
  note "Public address: $ADDR"
  note "Checking it from the internet (the first certificate can take a minute)…"
  for i in $(seq 1 60); do curl -fsS --max-time 10 "$ADDR/api/health" >/dev/null 2>&1 && break; sleep 3; done
  curl -fsS --max-time 10 "$ADDR/api/health" >/dev/null 2>&1 && note "It answers." || note "It doesn't answer from here yet; give it a few minutes."
else
  LAN=$(hostname -I 2>/dev/null | awk '{print $1}'); ADDR="http://$LAN:$PORT"
fi

# 5. the links: one for Life Web, one for Claude (made the first time; making a new one stops the old one, so it's kept, not remade)
LINK="$ADDR/connect#$TOKEN"
CLAUDE=""
if [ "$FIRST" = 1 ] || ! grep -q '^Claude' CONNECT.txt 2>/dev/null; then
  CPATH=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/connector-link" | grep -o '"path":"[^"]*"' | cut -d'"' -f4 || true)
  [ -n "$CPATH" ] && CLAUDE="$ADDR$CPATH"
else
  CLAUDE=$(grep '^Claude' CONNECT.txt | sed 's/^[^:]*: *//')
fi
( umask 077; cat > CONNECT.txt <<TXT
Life Web Cloud — keep this file private: both links open your boards.
Server address: $ADDR
Life Web connection link: $LINK
Claude connector link: $CLAUDE
TXT
)
say "Done. Life Web Cloud is running at $ADDR"
note "1. In Life Web: File › Connections… › paste this into \"Connection link or invite\" and press Connect:"
printf '\n      \033[1;33m%s\033[0m\n\n' "$LINK"
if [ -n "$CLAUDE" ]; then
  note "2. In Claude (the app, the web or the phone): Settings › Connectors › Add custom connector, and paste:"
  printf '\n      \033[1;33m%s\033[0m\n\n' "$CLAUDE"
fi
note "Both are kept in $DIR/CONNECT.txt (show them again with: cat $DIR/CONNECT.txt). Keep them private."
note "To update later, run the same command again."
