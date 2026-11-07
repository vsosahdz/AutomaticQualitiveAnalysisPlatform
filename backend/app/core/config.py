"""Configuración central de la aplicación.

Todas las constantes viven aquí para poder ajustarlas en un solo lugar
(o sobreescribirlas por variable de entorno). Ver README para la lista.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

# Carga variables desde un archivo .env (si existe) antes de leer os.getenv.
# Así la configuración local vive en backend/.env sin tocar el entorno global.
load_dotenv()


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# --- Proveedor de LLM -----------------------------------------------------
# Selecciona la implementación de LLMProvider (ver app/services/llm/factory.py).
# Hoy: 'ollama' (local). Mañana: 'cloud' u otro, sin tocar el pipeline.
LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "ollama")
LLM_TEMPERATURE: float = float(os.getenv("LLM_TEMPERATURE", "0"))
LLM_TIMEOUT_SECONDS: int = _int_env("LLM_TIMEOUT_SECONDS", 300)
LLM_MAX_RETRIES: int = _int_env("LLM_MAX_RETRIES", 2)

# --- Embeddings (comparación semántica, Fase II) --------------------------
# Modelo de embeddings local para la similitud de citas (bge-m3 ya descargado).
EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "bge-m3:latest")
# Umbral por defecto de similitud del coseno para considerar "mismo hallazgo".
SEMANTIC_THRESHOLD: float = float(os.getenv("SEMANTIC_THRESHOLD", "0.7"))

# --- Ollama (proveedor local) ---------------------------------------------
# Por defecto 11435: en el equipo de despliegue el 11434 lo ocupa otro servicio
# (un chatbot) y Ollama quedó en 11435. Los scripts exportan el puerto resuelto
# (ver scripts/lib.sh · resolve_ollama_host), que tiene prioridad sobre este default.
OLLAMA_HOST: str = os.getenv("OLLAMA_HOST", "http://localhost:11435")
# qwen2.5:14b da mejor precisión que el 7b en la evaluación (F1 0.96 vs 0.87);
# es el modelo por defecto. Para un arranque más ligero/rápido, sobreescribe con
# OLLAMA_MODEL=qwen2.5:latest (7b) en backend/.env.
OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen2.5:14b")

# --- Rendimiento de Ollama ------------------------------------------------
# Contexto acotado: las ventanas (~1500-2000 tokens) + codebook caben en 8192.
# Evita cargar el contexto máximo del modelo (p. ej. 32K), reduciendo memoria y
# tiempo de prefill.
OLLAMA_NUM_CTX: int = _int_env("OLLAMA_NUM_CTX", 8192)
# Mantiene el modelo cargado entre llamadas (evita recargas). Formato de Ollama.
OLLAMA_KEEP_ALIVE: str = os.getenv("OLLAMA_KEEP_ALIVE", "30m")
# Razonamiento (thinking) de modelos que lo soporten. Por defecto desactivado
# (más rápido); los modelos que no lo soportan ignoran el parámetro.
OLLAMA_THINK: bool = os.getenv("OLLAMA_THINK", "false").strip().lower() in (
    "1", "true", "yes", "si", "sí",
)

# --- LLM en la nube (proveedor futuro, placeholder) -----------------------
# Se leen aquí para dejar el punto de extensión listo; el proveedor 'cloud'
# aún no está implementado (ver factory.py).
CLOUD_LLM_BASE_URL: str = os.getenv("CLOUD_LLM_BASE_URL", "")
CLOUD_LLM_API_KEY: str = os.getenv("CLOUD_LLM_API_KEY", "")
CLOUD_LLM_MODEL: str = os.getenv("CLOUD_LLM_MODEL", "")

# --- Codebook -------------------------------------------------------------
# Máximo de códigos custom. Configurable: cambiarlo aquí mueve el límite
# en la validación del backend (el frontend lee su propio máximo).
MAX_CUSTOM_CODES: int = _int_env("MAX_CUSTOM_CODES", 3)

# --- Segmentación / ventanas ---------------------------------------------
# Si una transcripción supera WINDOW_CHARS se procesa en ventanas que
# solapan WINDOW_OVERLAP caracteres, preservando IDs de unidad globales.
WINDOW_CHARS: int = _int_env("WINDOW_CHARS", 6000)
WINDOW_OVERLAP: int = _int_env("WINDOW_OVERLAP", 500)

# --- Colores base (por código semilla) -----------------------------------
BASE_CODE_COLORS: dict[str, str] = {
    "barrera": "#E4572E",       # rojo/naranja
    "facilitador": "#2E933C",   # verde
    "estrategia": "#3A6EA5",    # azul
}

# Paleta para autoasignar color a códigos custom (el frontend también la usa).
CUSTOM_CODE_PALETTE: list[str] = [
    "#7B4FA3", "#C9A227", "#0FA3B1", "#D7263D", "#5C6672",
]

# --- CORS -----------------------------------------------------------------
CORS_ORIGINS: list[str] = os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")
