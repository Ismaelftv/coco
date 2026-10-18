#!/usr/bin/env bash
# Arranca um cluster PostgreSQL 16 local e descartável para desenvolvimento e testes.
# Uso: scripts/pg-local.sh start|stop|status
# Variáveis: PGLOCAL_DIR (dados), PGLOCAL_PORT (porta, 54329), PGLOCAL_PASSWORD.
set -euo pipefail
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
DIR=${PGLOCAL_DIR:-/tmp/forja-pg}
PORT=${PGLOCAL_PORT:-54329}
PASS=${PGLOCAL_PASSWORD:-forja-dev-only}
RUN=()
if [ "$(id -u)" = "0" ]; then RUN=(runuser -u postgres --); fi

case "${1:-start}" in
  start)
    if [ ! -f "$DIR/PG_VERSION" ]; then
      mkdir -p "$DIR"; [ "$(id -u)" = "0" ] && chown postgres:postgres "$DIR"
      PWFILE=$(mktemp); echo "$PASS" > "$PWFILE"; chmod 644 "$PWFILE"
      "${RUN[@]}" "$BIN/initdb" -D "$DIR" -U forja --pwfile="$PWFILE" -A scram-sha-256 -E UTF8 --locale=C.UTF-8 >/dev/null
      rm -f "$PWFILE"
      # Certificado autoassinado para testar o caminho TLS do cliente.
      "${RUN[@]}" openssl req -new -x509 -days 30 -nodes -subj "/CN=localhost" \
        -keyout "$DIR/server.key" -out "$DIR/server.crt" >/dev/null 2>&1
      "${RUN[@]}" chmod 600 "$DIR/server.key"
      cat >> "$DIR/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$DIR'
ssl = on
fsync = off
synchronous_commit = off
CONF
    fi
    if ! "${RUN[@]}" "$BIN/pg_ctl" -D "$DIR" status >/dev/null 2>&1; then
      "${RUN[@]}" "$BIN/pg_ctl" -D "$DIR" -l "$DIR/server.log" -w start >/dev/null
    fi
    echo "postgres://forja:$PASS@127.0.0.1:$PORT/postgres"
    ;;
  stop) "${RUN[@]}" "$BIN/pg_ctl" -D "$DIR" -w stop >/dev/null && echo parado ;;
  status) "${RUN[@]}" "$BIN/pg_ctl" -D "$DIR" status ;;
  *) echo "uso: $0 start|stop|status" >&2; exit 2 ;;
esac
