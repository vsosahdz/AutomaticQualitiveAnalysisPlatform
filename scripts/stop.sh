#!/usr/bin/env bash
# Detiene los servicios levantados en segundo plano (por --bg o dev.sh).
# Usa los PID guardados en .logs/ y, como respaldo, mata por puerto.
#
# Uso:  ./scripts/stop.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Detiene un proceso a partir de su archivo .pid, si existe y sigue vivo.
stop_pidfile() {
  local name="$1" pidfile="$2"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill "$pid" 2>/dev/null; then
      ok "$name detenido (PID $pid)"
    else
      warn "$name (PID $pid) no estaba activo"
    fi
    rm -f "$pidfile"
  fi
}

stop_pidfile "Backend" "$LOG_DIR/backend.pid"
stop_pidfile "Frontend" "$LOG_DIR/frontend.pid"

# Respaldo: libera los puertos por si quedaron procesos huérfanos.
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  pid="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    kill $pid 2>/dev/null && ok "Liberado el puerto $port (PID $pid)" || true
  fi
done

ok "Servicios detenidos."
