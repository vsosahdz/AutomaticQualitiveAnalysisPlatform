# Automatic Qualitative Analysis Platform

LLM-assisted qualitative coding of interview transcripts. The platform takes
Spanish-language interview transcripts (`.txt`) and, using a **local LLM served by
[Ollama](https://ollama.com)**, identifies the fragments that match a codebook
(three base codes — *Barrera* / Barrier, *Facilitador* / Facilitator,
*Estrategia* / Strategy — plus up to three user-defined codes). Results are shown
in a color-highlighted viewer and can be exported as CSV.

> The user interface, the prompt and the codebook are in Spanish.

## How it works

1. **Segmentation** — each transcript is split into sentence units with exact
   character offsets (`backend/app/services/segmentation.py`).
2. **Windowing** — long documents are processed in overlapping windows
   (6000 characters, 500 overlap) that keep global unit IDs.
3. **Coding** — each window is sent to the LLM with the active codebook. The model
   answers with unit-ID ranges, a code and a justification, constrained by a JSON
   Schema whose `code` field is an enum of the active labels
   (`backend/app/services/llm/base.py`).
4. **Validation** — unknown codes and out-of-range IDs are discarded and logged;
   IDs are resolved to exact offsets, and duplicate or nested ranges of the same
   code are merged (`backend/app/services/coding.py`).

Additional features: consensus coding across several models, comparison against a
human-coded CSV (exact and embedding-based semantic matching), and a Word report
of the findings detected only by the LLM.

## Repository layout

```
.
├── backend/    # Python + FastAPI (routes / controllers / services / models / jobs)
├── frontend/   # React + Vite + TypeScript
├── samples/    # Example (synthetic) transcripts and a human-coded CSV
└── scripts/    # Setup and run scripts
```

## Requirements

- Python 3.10+
- Node.js 18+
- [Ollama](https://ollama.com) running, with these models:

  ```bash
  ollama pull qwen2.5:14b   # coding model (default)
  ollama pull bge-m3        # embeddings for semantic comparison
  # optional lighter/faster coding model:
  ollama pull qwen2.5       # 7B; use with OLLAMA_MODEL=qwen2.5:latest
  ```

## Quick start

From the repository root:

```bash
./scripts/setup.sh   # creates the Python venv, installs backend and frontend
                     # dependencies, creates the .env files and pulls the models
                     # (set SKIP_MODELS=1 to skip the model download)

./scripts/dev.sh     # starts backend + frontend (Ctrl+C stops both)
```

Then open http://localhost:5173.

The scripts auto-detect the Ollama port (they try `11435`, then `11434`). To force a
host, set `OLLAMA_HOST` in `backend/.env`.

Background mode: `./scripts/start-backend.sh --bg` and
`./scripts/start-frontend.sh --bg`; stop with `./scripts/stop.sh`.

## Manual start

**Backend**

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
OLLAMA_HOST=http://localhost:11434 uvicorn app.main:app --port 8000
```

- API: http://localhost:8000
- Swagger UI: http://localhost:8000/docs
- OpenAPI JSON: http://localhost:8000/openapi.json

**Frontend**

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

- App: http://localhost:5173 (Vite proxies `/api` to the backend on port 8000)

## API

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/health`                 | Service status |
| GET  | `/models`                 | Generation models available in Ollama |
| POST | `/process`                | Queue a coding job (returns `202` + `job_id`) |
| GET  | `/jobs/{job_id}`          | Job status and progress |
| POST | `/jobs/{job_id}/cancel`   | Cancel a running job |
| GET  | `/jobs/{job_id}/result`   | Full JSON result |
| GET  | `/jobs/{job_id}/csv`      | Result as CSV |
| GET  | `/jobs/{job_id}/csv.zip`  | One CSV per document, zipped |
| POST | `/compare`                | Compare LLM coding against human coding |
| POST | `/human/summary`          | Summarize an imported human-coded CSV |
| POST | `/report/docx`            | Word report of LLM-only findings |

## Configuration

Backend environment variables (all optional; see `backend/.env.example` and
`backend/app/core/config.py`):

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST`         | `http://localhost:11435` | Ollama server URL (scripts auto-detect 11435 → 11434) |
| `OLLAMA_MODEL`        | `qwen2.5:14b`            | Coding model |
| `LLM_TEMPERATURE`     | `0`                      | Sampling temperature |
| `OLLAMA_NUM_CTX`      | `8192`                   | Context window |
| `OLLAMA_THINK`        | `false`                  | Reasoning mode for models that support it |
| `LLM_MAX_RETRIES`     | `2`                      | Retries on network or invalid-JSON errors |
| `EMBEDDING_MODEL`     | `bge-m3:latest`          | Embedding model for semantic comparison |
| `SEMANTIC_THRESHOLD`  | `0.7`                    | Cosine similarity threshold |
| `MAX_CUSTOM_CODES`    | `3`                      | Maximum number of user-defined codes |
| `WINDOW_CHARS`        | `6000`                   | Window size (characters) |
| `WINDOW_OVERLAP`      | `500`                    | Overlap between windows (characters) |

## Tests

```bash
cd backend && source .venv/bin/activate
pytest
```

## Precision evaluation

`backend/eval_precision.py` measures sentence-level precision, recall and F1 of the
coding pipeline against a small gold standard over the transcripts in `samples/`.
It reads the base code definitions from `frontend/src/codebook.ts`, so it evaluates
exactly the codebook the application uses. Each model is run with and without the
merging of same-code overlapping fragments:

```bash
cd backend && source .venv/bin/activate
# set OLLAMA_HOST if Ollama is not on the default port (11435)
OLLAMA_HOST=http://localhost:11434 OLLAMA_MODEL=qwen2.5:14b    python eval_precision.py
OLLAMA_HOST=http://localhost:11434 OLLAMA_MODEL=qwen2.5:latest python eval_precision.py
```

## License

Released under the [MIT License](LICENSE).
