#!/usr/bin/env bash
# Levanta backend y frontend juntos para desarrollo. El backend corre en segundo
# plano (log a archivo) y el frontend en primer plano; al pulsar Ctrl+C se
# detienen ambos limpiamente.
#
# Uso:  ./scripts/dev.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Comprobaciones mínimas antes de arrancar.
if [ ! -x "$VENV_DIR/bin/uvicorn" ] || [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  err "Falta instalar dependencias. Ejecuta primero ./scripts/setup.sh"
  exit 1
fi

mkdir -p "$LOG_DIR"

# Al salir, detiene el backend que dejamos en segundo plano.
cleanup() {
  echo
  info "Deteniendo servicios…"
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  ok "Listo."
}
trap cleanup EXIT INT TERM

# Resuelve el puerto de Ollama (11434 o 11435) y verifica los modelos requeridos.
resolve_ollama_host || true
if check_ollama; then
  check_required_models || true
else
  warn "Ollama no está listo; el backend fallará al codificar/comparar."
fi

# Libera los puertos si un dev.sh/prod.sh anterior o un proceso huérfano los dejó
# ocupados (evita fallos de "address already in use").
free_port "$BACKEND_PORT"
free_port "$FRONTEND_PORT"

# --- Backend en segundo plano ---
info "Levantando backend (puerto $BACKEND_PORT)…"
( cd "$BACKEND_DIR" && exec "$VENV_DIR/bin/uvicorn" app.main:app --port "$BACKEND_PORT" --log-level info ) \
  > "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
ok "Backend PID $BACKEND_PID · log: .logs/backend.log · http://localhost:$BACKEND_PORT/docs"

# --- Frontend en primer plano (bloquea hasta Ctrl+C) ---
info "Levantando frontend (puerto $FRONTEND_PORT)…"
echo "  App: http://localhost:$FRONTEND_PORT"
( cd "$FRONTEND_DIR" && npm run dev -- --port "$FRONTEND_PORT" )
