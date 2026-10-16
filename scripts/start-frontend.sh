#!/usr/bin/env bash
# Levanta el frontend (Vite dev server).
#
# Uso:
#   ./scripts/start-frontend.sh           # primer plano (desarrollo)
#   ./scripts/start-frontend.sh --bg      # segundo plano, log en .logs/frontend.log
#
# Variables: FRONTEND_PORT (por defecto 5173).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Verifica que las dependencias estén instaladas.
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  err "No se encontró node_modules. Ejecuta primero ./scripts/setup.sh"
  exit 1
fi

cd "$FRONTEND_DIR"

if [ "${1:-}" = "--bg" ]; then
  mkdir -p "$LOG_DIR"
  info "Levantando frontend en segundo plano (puerto $FRONTEND_PORT)…"
  nohup npm run dev -- --port "$FRONTEND_PORT" > "$LOG_DIR/frontend.log" 2>&1 &
  echo $! > "$LOG_DIR/frontend.pid"
  ok "Frontend PID $(cat "$LOG_DIR/frontend.pid") · log: .logs/frontend.log"
  echo "  App: http://localhost:$FRONTEND_PORT"
else
  info "Levantando frontend (puerto $FRONTEND_PORT). Ctrl+C para detener."
  echo "  App: http://localhost:$FRONTEND_PORT"
  exec npm run dev -- --port "$FRONTEND_PORT"
fi
