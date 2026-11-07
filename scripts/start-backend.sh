#!/usr/bin/env bash
# Levanta el backend (FastAPI + Uvicorn).
#
# Uso:
#   ./scripts/start-backend.sh            # primer plano, con --reload (desarrollo)
#   ./scripts/start-backend.sh --bg       # segundo plano, log en .logs/backend.log
#
# Variables: BACKEND_PORT (por defecto 8000).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Verifica que el setup se haya ejecutado.
if [ ! -x "$VENV_DIR/bin/uvicorn" ]; then
  err "No se encontró el venv del backend. Ejecuta primero ./scripts/setup.sh"
  exit 1
fi

# Resuelve el puerto de Ollama (11434 o 11435) y verifica los modelos requeridos
# (análisis + embeddings). OLLAMA_HOST se exporta para que lo herede el backend.
resolve_ollama_host || true
if check_ollama; then
  check_required_models || true
else
  warn "Ollama no está listo; el backend arranca pero fallará al codificar/comparar."
fi

cd "$BACKEND_DIR"

if [ "${1:-}" = "--bg" ]; then
  # Modo segundo plano: sin --reload, log a archivo, guarda el PID.
  mkdir -p "$LOG_DIR"
  info "Levantando backend en segundo plano (puerto $BACKEND_PORT)…"
  nohup "$VENV_DIR/bin/uvicorn" app.main:app --port "$BACKEND_PORT" --log-level info \
    > "$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$LOG_DIR/backend.pid"
  ok "Backend PID $(cat "$LOG_DIR/backend.pid") · log: .logs/backend.log"
  echo "  API:     http://localhost:$BACKEND_PORT"
  echo "  Swagger: http://localhost:$BACKEND_PORT/docs"
else
  # Modo desarrollo: primer plano con recarga en caliente.
  info "Levantando backend (puerto $BACKEND_PORT, --reload). Ctrl+C para detener."
  echo "  Swagger: http://localhost:$BACKEND_PORT/docs"
  exec "$VENV_DIR/bin/uvicorn" app.main:app --reload --port "$BACKEND_PORT"
fi
