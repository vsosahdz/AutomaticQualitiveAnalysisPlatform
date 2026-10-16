#!/usr/bin/env bash
# Instalación completa: verifica prerrequisitos, crea el venv del backend e
# instala sus dependencias, instala las del frontend y prepara los archivos .env.
# Idempotente: se puede correr varias veces sin problema.
#
# Uso:  ./scripts/setup.sh

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

info "Verificando prerrequisitos…"

# --- Python ---
PY="$(detect_python)"
ok "Python: $PY ($($PY --version 2>&1))"

# --- Node / npm ---
if ! command -v node >/dev/null 2>&1; then
  err "Node.js no está instalado (se requiere 18+)."; exit 1
fi
ok "Node: $(node --version)  npm: $(npm --version)"

# --- Ollama (aviso, no bloqueante) ---
# Resuelve el puerto (11434, o 11435 si el 11434 lo ocupa otro servicio).
resolve_ollama_host || true
OLLAMA_OK=0
if check_ollama; then
  ok "Ollama disponible y respondiendo en $OLLAMA_HOST"
  OLLAMA_OK=1
else
  warn "Continúo, pero el backend necesitará Ollama en marcha para funcionar."
fi

# --- Backend: venv + dependencias ---
info "Configurando el backend…"
if [ ! -d "$VENV_DIR" ]; then
  "$PY" -m venv "$VENV_DIR"
  ok "venv creado en backend/.venv"
else
  ok "venv ya existe"
fi
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$BACKEND_DIR/requirements.txt"
ok "Dependencias del backend instaladas"

# Copia backend/.env desde el ejemplo si no existe.
if [ ! -f "$BACKEND_DIR/.env" ] && [ -f "$BACKEND_DIR/.env.example" ]; then
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  ok "Creado backend/.env desde .env.example"
fi

# --- Frontend: dependencias ---
info "Configurando el frontend…"
( cd "$FRONTEND_DIR" && npm install --silent )
ok "Dependencias del frontend instaladas"

# Copia frontend/.env desde el ejemplo si no existe.
if [ ! -f "$FRONTEND_DIR/.env" ] && [ -f "$FRONTEND_DIR/.env.example" ]; then
  cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env"
  ok "Creado frontend/.env desde .env.example"
fi

# --- Modelos de Ollama requeridos (análisis + embeddings de comparación) ---
# Se leen de backend/.env (ya creado) para respetar la configuración elegida.
MODELS="$(required_models | tr '\n' ' ')"
if [ "${SKIP_MODELS:-0}" = "1" ]; then
  warn "SKIP_MODELS=1: omito la descarga de modelos. Requeridos: $MODELS"
elif [ "$OLLAMA_OK" = "1" ]; then
  info "Verificando modelos de Ollama requeridos: $MODELS"
  while IFS= read -r m; do
    [ -n "$m" ] && ensure_model "$m"
  done < <(required_models)
else
  warn "Ollama no está disponible; no se descargaron modelos."
  warn "Cuando Ollama esté en marcha, descarga: $MODELS"
  warn "(o vuelve a ejecutar ./scripts/setup.sh)"
fi

echo
ok "Instalación completa."
echo "Siguiente paso:"
echo "  • Todo junto:      ./scripts/dev.sh"
echo "  • Solo backend:    ./scripts/start-backend.sh"
echo "  • Solo frontend:   ./scripts/start-frontend.sh"
