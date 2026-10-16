#!/usr/bin/env bash
# Utilidades compartidas por los scripts. No se ejecuta directamente; se importa
# con `source`. Define rutas, colores, y helpers de logging y de detección de
# herramientas (Python, Node, Ollama).

set -euo pipefail

# --- Rutas del proyecto (raíz = carpeta padre de scripts/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/.venv"
LOG_DIR="$ROOT_DIR/.logs"

# Puertos por defecto (sobreescribibles por entorno).
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

# Servidor de Ollama (respeta la variable de entorno si está definida). Por defecto
# 11435: en el equipo de despliegue el 11434 lo ocupa otro servicio (un chatbot) y
# Ollama quedó en 11435. resolve_ollama_host() ajusta esto según lo que responda.
OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11435}"

# --- Colores para mensajes ---
if [ -t 1 ]; then
  C_INFO="\033[0;36m"; C_OK="\033[0;32m"; C_WARN="\033[0;33m"; C_ERR="\033[0;31m"; C_OFF="\033[0m"
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi

info() { printf "${C_INFO}▶ %s${C_OFF}\n" "$*"; }
ok()   { printf "${C_OK}✓ %s${C_OFF}\n" "$*"; }
warn() { printf "${C_WARN}⚠ %s${C_OFF}\n" "$*"; }
err()  { printf "${C_ERR}✗ %s${C_OFF}\n" "$*" >&2; }

# Devuelve los PID que ESCUCHAN en un puerto TCP (uno por línea); vacío si ninguno.
# Usa lsof si está disponible y, si no, ss (Linux). Portable a macOS y Linux.
port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$port" 2>/dev/null \
      | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
  fi
}

# Libera un puerto TCP: termina el proceso que lo escucha (TERM y, si insiste, KILL).
# Idempotente: si el puerto ya está libre, no hace nada. Uso: free_port 8000
free_port() {
  local port="$1" pids
  pids="$(port_pids "$port")"
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086
  warn "Puerto $port ocupado (PID: $(echo $pids | tr '\n' ' ')); liberando…"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
  if [ -z "$(port_pids "$port")" ]; then
    ok "Puerto $port liberado"
  else
    warn "No pude liberar el puerto $port; revisa qué proceso lo usa (lsof -i :$port)."
  fi
}

# Elige un intérprete de Python 3.10+ (prefiere python3.12, luego python3.11/3.10,
# luego python3 si cumple la versión). Imprime la ruta o falla.
detect_python() {
  local candidate
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)' 2>/dev/null; then
        echo "$candidate"
        return 0
      fi
    fi
  done
  err "No se encontró Python 3.10+ (se recomienda python3.12)."
  return 1
}

# Verifica que Ollama esté instalado y el servidor responda; avisa si no.
check_ollama() {
  if ! command -v ollama >/dev/null 2>&1; then
    warn "Ollama no está instalado. Instálalo desde https://ollama.com"
    return 1
  fi
  if ! curl -s -m 3 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
    warn "El servidor de Ollama no responde en $OLLAMA_HOST. Ejecuta 'ollama serve'."
    return 1
  fi
  return 0
}

# Lee el valor "crudo" de una variable (env var > backend/.env), SIN default.
# Devuelve vacío si no está declarada en ninguno de los dos.
env_value_raw() {
  local key="$1"
  # Asignaciones en líneas separadas: en una sola, ${!key} se evaluaría antes de
  # asignar key y se perdería la variable de entorno.
  local val="${!key:-}"
  if [ -z "$val" ] && [ -f "$BACKEND_DIR/.env" ]; then
    # `|| true` evita que un grep sin coincidencias (con pipefail) aborte el script.
    val="$(grep -E "^${key}=" "$BACKEND_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'" | tr -d ' ' || true)"
  fi
  echo "$val"
}

# Lee el valor de una variable (env var > backend/.env > default).
# Uso: env_value CLAVE DEFECTO
env_value() {
  local val; val="$(env_value_raw "$1")"
  echo "${val:-$2}"
}

# ¿Responde Ollama en este host? Busca la firma de /api/tags (clave "models").
is_ollama() {
  curl -s -m 3 "$1/api/tags" 2>/dev/null | grep -q '"models"'
}

# Resuelve y EXPORTA OLLAMA_HOST para que backend, `ollama` y curl usen el mismo:
#   1) usa el host configurado (env var o backend/.env) SOLO si Ollama responde ahí;
#   2) si no responde como Ollama (p. ej. el 11434 lo ocupa un chatbot), autodetecta:
#      11435 primero y luego 11434, y usa el que sí sea Ollama;
#   3) si nada responde, deja el configurado (o 11435 por defecto) y avisa.
resolve_ollama_host() {
  local explicit; explicit="$(env_value_raw OLLAMA_HOST)"
  # 1) Host configurado: se usa DIRECTO solo si Ollama responde ahí. Si el puerto
  #    configurado lo ocupa otro servicio (p. ej. un chatbot en 11434), se ignora y
  #    se autodetecta el puerto correcto en el paso 2.
  if [ -n "$explicit" ] && is_ollama "$explicit"; then
    export OLLAMA_HOST="$explicit"
    ok "Ollama en $OLLAMA_HOST (configurado)"
    return 0
  fi
  # 2) Autodetección: 11435 primero (puerto de despliegue, donde el 11434 lo ocupa
  #    otro servicio) y luego 11434. Se usa el primero que responda como Ollama.
  local h
  for h in "http://localhost:11435" "http://localhost:11434"; do
    if is_ollama "$h"; then
      export OLLAMA_HOST="$h"
      if [ -n "$explicit" ] && [ "$explicit" != "$h" ]; then
        warn "OLLAMA_HOST=$explicit no respondió como Ollama; uso $h (detectado)."
      else
        ok "Ollama detectado en $h"
      fi
      return 0
    fi
  done
  # 3) Nada respondió: 11435 por defecto (o el configurado, si lo hay) y avisa.
  export OLLAMA_HOST="${explicit:-http://localhost:11435}"
  warn "No detecté Ollama en 11435 ni 11434; uso $OLLAMA_HOST. ¿Corre 'ollama serve'?"
  return 1
}

# Verifica que estén los modelos requeridos (análisis + embeddings); avisa si faltan.
check_required_models() {
  local missing=0 m
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    if ollama_has_model "$m"; then
      ok "Modelo presente: $m"
    else
      warn "Falta el modelo '$m' (descárgalo: ollama pull $m)"
      missing=1
    fi
  done < <(required_models)
  return $missing
}

# Lista los modelos de Ollama que el backend necesita (respeta backend/.env).
# El modelo de análisis por defecto y el de embeddings (comparación semántica).
required_models() {
  env_value OLLAMA_MODEL "qwen2.5:14b"
  env_value EMBEDDING_MODEL "bge-m3:latest"
}

# Indica si un modelo ya está descargado en Ollama, consultando la API HTTP en
# OLLAMA_HOST (así verifica en el puerto resuelto, p. ej. 11435, no el default del CLI).
ollama_has_model() {
  curl -s -m 5 "$OLLAMA_HOST/api/tags" 2>/dev/null \
    | python3 -c "import sys,json;
d=json.load(sys.stdin); print('\n'.join(m.get('name','') for m in d.get('models',[])))" 2>/dev/null \
    | grep -qx "$1"
}

# Descarga un modelo si falta (idempotente).
ensure_model() {
  local name="$1"
  if ollama_has_model "$name"; then
    ok "Modelo presente: $name"
    return 0
  fi
  info "Descargando modelo '$name' (puede tardar y pesar varios GB)…"
  if ollama pull "$name"; then
    ok "Modelo descargado: $name"
  else
    warn "No se pudo descargar '$name'. Descárgalo luego con: ollama pull $name"
    return 1
  fi
}
