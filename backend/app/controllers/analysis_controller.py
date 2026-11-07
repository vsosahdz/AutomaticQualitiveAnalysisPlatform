"""Controlador de análisis: orquesta la petición de codificación.

Valida la entrada, crea el trabajo, dispara la codificación en segundo plano y
expone la recuperación de estado, resultado y CSV. Mantiene las rutas delgadas:
toda la orquestación vive aquí, y la lógica pesada en los ``services``.
"""
from __future__ import annotations

import time
from typing import List

from app.models.code import Code
from app.models.requests import ProcessRequest
from app.models.results import JobStatus, Result
from app.core import config
from app.services import coding, consensus, csv_export
from app.services.llm import get_provider, list_models
from app.jobs.job_store import job_store


class ValidationError(ValueError):
    """Entrada inválida de la petición (se traduce a HTTP 422 en la ruta)."""


class NotFoundError(LookupError):
    """Recurso inexistente (se traduce a HTTP 404 en la ruta)."""


class NotReadyError(RuntimeError):
    """El trabajo existe pero su resultado aún no está listo (HTTP 409)."""


def _validate_request(request: ProcessRequest) -> List[Code]:
    """Valida el payload y devuelve la lista de códigos activos.

    Args:
        request: cuerpo de ``POST /process`` ya deserializado por Pydantic.

    Returns:
        Los códigos activos del codebook.

    Raises:
        ValidationError: si no hay ningún código activo o no hay documentos.
    """
    if not request.documents:
        raise ValidationError("Se requiere al menos un documento")
    active = [c for c in request.codebook if c.active]
    if not active:
        raise ValidationError("Se requiere al menos un código activo en el codebook")
    # Modo consenso: la lista de modelos debe tener 2 o 3 elementos.
    if request.models is not None and not (2 <= len(request.models) <= 3):
        raise ValidationError("El consenso requiere de 2 a 3 modelos")
    return active


def _is_consensus(request: ProcessRequest) -> bool:
    """Indica si la petición es de análisis por consenso (2–3 modelos)."""
    return bool(request.models and len(request.models) >= 2)


def _run_job(job_id: str, request: ProcessRequest) -> None:
    """Ejecuta la codificación de todos los documentos y actualiza el trabajo.

    Pensada para correr en un hilo/tarea de fondo. Actualiza el progreso global
    combinando el avance por documento y guarda el resultado o el error.

    Args:
        job_id: identificador del trabajo a actualizar.
        request: payload original con documentos y codebook.
    """
    job_store.set_running(job_id)
    # Cierre que el pipeline consulta para saber si debe abortar.
    def cancelled() -> bool:
        return job_store.is_cancel_requested(job_id)

    consensus_mode = _is_consensus(request)
    # Proveedor único (modo de un modelo); en consenso cada modelo tiene el suyo.
    provider = None if consensus_mode else get_provider(request.model)

    try:
        documents = []
        dropped_all = []
        total_docs = max(len(request.documents), 1)

        for index, doc in enumerate(request.documents):
            # Cancelación también entre documentos (además de entre ventanas).
            if cancelled():
                raise coding.CodingCancelled()

            # Reporta el progreso combinando el índice del documento con el avance
            # interno (por ventana/modelo) que emite el pipeline.
            def report(fraction: float, message: str, _i: int = index) -> None:
                overall = (_i + fraction) / total_docs
                job_store.update_progress(job_id, overall, message)

            # Mide el tiempo de codificación de este documento.
            started = time.perf_counter()
            if consensus_mode:
                document, dropped = consensus.code_document_consensus(
                    name=doc.name,
                    text=doc.content,
                    codebook=request.codebook,
                    models=request.models,  # type: ignore[arg-type]
                    progress=report,
                    should_cancel=cancelled,
                )
            else:
                document, dropped = coding.code_document(
                    name=doc.name,
                    text=doc.content,
                    codebook=request.codebook,
                    provider=provider,
                    progress=report,
                    should_cancel=cancelled,
                )
            document.elapsed_seconds = round(time.perf_counter() - started, 2)
            documents.append(document)
            dropped_all.extend(dropped)

        total_seconds = round(sum(d.elapsed_seconds for d in documents), 2)
        result = Result(
            documents=documents,
            dropped=dropped_all,
            total_seconds=total_seconds,
            analysis_type="consensus" if consensus_mode else "single",
            models=list(request.models) if consensus_mode else (
                [request.model] if request.model else []
            ),
        )
        job_store.set_done(job_id, result)
    except coding.CodingCancelled:
        # Aborto solicitado por la persona usuaria: estado terminal 'cancelled'.
        job_store.set_cancelled(job_id)
    except Exception as exc:  # noqa: BLE001 - se refleja como estado de error del job
        job_store.set_error(job_id, str(exc))


def start_processing(request: ProcessRequest, schedule) -> str:
    """Valida, crea el trabajo y agenda su ejecución en segundo plano.

    Args:
        request: payload de ``POST /process``.
        schedule: función para agendar la tarea de fondo (p. ej.
            ``BackgroundTasks.add_task`` de FastAPI). Recibe ``(_run_job, job_id, request)``.

    Returns:
        El ``job_id`` del trabajo creado.

    Raises:
        ValidationError: si la entrada no es válida.
    """
    _validate_request(request)
    job_id = job_store.create()
    schedule(_run_job, job_id, request)
    return job_id


def get_models() -> dict:
    """Devuelve los modelos disponibles y el modelo por defecto.

    Returns:
        Dict con ``models`` (lista de nombres) y ``default`` (modelo configurado).
    """
    models = list_models()
    default = config.OLLAMA_MODEL if config.LLM_PROVIDER == "ollama" else config.CLOUD_LLM_MODEL
    # Garantiza que el default aparezca en la lista aunque el servidor no lo liste.
    if default and default not in models:
        models = [default, *models]
    return {"models": models, "default": default}


def cancel_processing(job_id: str) -> None:
    """Solicita cancelar un trabajo en curso (cancelación cooperativa).

    Raises:
        NotFoundError: si el trabajo no existe.
        ValidationError: si el trabajo ya terminó y no puede cancelarse.
    """
    if not job_store.exists(job_id):
        raise NotFoundError(f"Trabajo no encontrado: {job_id}")
    if not job_store.request_cancel(job_id):
        raise ValidationError("El trabajo ya no puede cancelarse (ya terminó)")


def get_status(job_id: str) -> JobStatus:
    """Devuelve el estado de un trabajo.

    Raises:
        NotFoundError: si el trabajo no existe.
    """
    status = job_store.get_status(job_id)
    if status is None:
        raise NotFoundError(f"Trabajo no encontrado: {job_id}")
    return status


def get_result(job_id: str) -> Result:
    """Devuelve el resultado JSON rico de un trabajo terminado.

    Raises:
        NotFoundError: si el trabajo no existe.
        NotReadyError: si el trabajo existe pero aún no terminó.
    """
    if not job_store.exists(job_id):
        raise NotFoundError(f"Trabajo no encontrado: {job_id}")
    result = job_store.get_result(job_id)
    if result is None:
        raise NotReadyError("El resultado todavía no está disponible")
    return result


def get_csv(job_id: str) -> str:
    """Devuelve el CSV combinado (todos los documentos) de un trabajo terminado.

    Raises:
        NotFoundError / NotReadyError: igual que :func:`get_result`.
    """
    result = get_result(job_id)
    return csv_export.result_to_csv(result)


def get_csv_zip(job_id: str) -> bytes:
    """Devuelve un ZIP con un CSV por documento de un trabajo terminado.

    Raises:
        NotFoundError / NotReadyError: igual que :func:`get_result`.
    """
    result = get_result(job_id)
    return csv_export.result_to_zip(result)
