"""Rutas de análisis: encolar codificación y recuperar estado/resultado/CSV.

Las rutas son delgadas: validan/entregan HTTP y delegan en el controlador. Cada
endpoint documenta sus códigos de estado para que Swagger/OpenAPI (y por ende
Postman) reflejen el contrato completo.
"""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, Response, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.controllers import analysis_controller
from app.models.requests import ProcessRequest
from app.models.results import JobStatus, Result

router = APIRouter(tags=["analysis"])


class ProcessResponse(BaseModel):
    """Respuesta de ``POST /process``: el ID del trabajo encolado."""

    job_id: str = Field(..., description="Identificador del trabajo creado")


class ModelsResponse(BaseModel):
    """Respuesta de ``GET /models``: modelos disponibles y el default."""

    models: list[str] = Field(..., description="Modelos de LLM disponibles")
    default: str = Field(..., description="Modelo usado si no se especifica otro")


@router.get(
    "/models",
    response_model=ModelsResponse,
    summary="Modelos de LLM disponibles",
    description="Lista los modelos disponibles en el proveedor y cuál es el default.",
    responses={200: {"description": "Modelos disponibles"}},
)
def get_models() -> ModelsResponse:
    """Devuelve los modelos disponibles para el combo del frontend."""
    data = analysis_controller.get_models()
    return ModelsResponse(**data)


@router.post(
    "/process",
    response_model=ProcessResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Encolar un trabajo de codificación",
    description=(
        "Recibe uno o varios documentos TXT y el codebook activo, valida la "
        "entrada y encola la codificación en segundo plano. Responde 202 con el "
        "job_id; el progreso se consulta en GET /jobs/{id}."
    ),
    responses={
        202: {"description": "Trabajo aceptado y encolado"},
        422: {"description": "Entrada inválida (sin documentos o sin códigos activos)"},
    },
)
def process(
    request: ProcessRequest, background_tasks: BackgroundTasks
) -> ProcessResponse:
    """Valida la petición y encola el trabajo de codificación."""
    try:
        job_id = analysis_controller.start_processing(
            request, schedule=background_tasks.add_task
        )
    except analysis_controller.ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )
    return ProcessResponse(job_id=job_id)


@router.get(
    "/jobs/{job_id}",
    response_model=JobStatus,
    summary="Estado y progreso de un trabajo",
    description="Devuelve el estado (pending/running/done/error) y el progreso 0..1.",
    responses={
        200: {"description": "Estado del trabajo"},
        404: {"description": "El trabajo no existe"},
    },
)
def get_job(job_id: str) -> JobStatus:
    """Devuelve el estado de un trabajo por su ID."""
    try:
        return analysis_controller.get_status(job_id)
    except analysis_controller.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.post(
    "/jobs/{job_id}/cancel",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Cancelar un trabajo en curso",
    description=(
        "Solicita la cancelación cooperativa de un trabajo pending/running. El "
        "pipeline se detiene antes de la siguiente ventana y el trabajo pasa a "
        "estado 'cancelled'."
    ),
    responses={
        202: {"description": "Cancelación solicitada"},
        404: {"description": "El trabajo no existe"},
        422: {"description": "El trabajo ya terminó y no puede cancelarse"},
    },
)
def cancel_job(job_id: str) -> dict:
    """Solicita cancelar un trabajo en curso."""
    try:
        analysis_controller.cancel_processing(job_id)
    except analysis_controller.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except analysis_controller.ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        )
    return {"status": "cancelling", "job_id": job_id}


@router.get(
    "/jobs/{job_id}/result",
    response_model=Result,
    summary="Resultado JSON rico de un trabajo",
    description=(
        "Devuelve el resultado (documentos con fragmentos: offsets, código, cita y "
        "justificación) cuando el trabajo ha terminado."
    ),
    responses={
        200: {"description": "Resultado del trabajo"},
        404: {"description": "El trabajo no existe"},
        409: {"description": "El trabajo aún no ha terminado"},
    },
)
def get_job_result(job_id: str) -> Result:
    """Devuelve el resultado JSON rico de un trabajo terminado."""
    try:
        return analysis_controller.get_result(job_id)
    except analysis_controller.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except analysis_controller.NotReadyError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get(
    "/jobs/{job_id}/csv",
    response_class=PlainTextResponse,
    summary="CSV derivado del resultado",
    description="Descarga el CSV (archivo, cita, codigo, justificacion) del trabajo terminado.",
    responses={
        200: {
            "description": "CSV del resultado",
            "content": {"text/csv": {}},
        },
        404: {"description": "El trabajo no existe"},
        409: {"description": "El trabajo aún no ha terminado"},
    },
)
def get_job_csv(job_id: str) -> PlainTextResponse:
    """Devuelve el CSV derivado del resultado como descarga."""
    try:
        csv_text = analysis_controller.get_csv(job_id)
    except analysis_controller.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except analysis_controller.NotReadyError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    # Se antepone el BOM UTF-8 para que Excel abra el CSV con los acentos y la ñ
    # correctamente; el charset explícito refuerza la codificación UTF-8.
    return PlainTextResponse(
        content="\ufeff" + csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="codificacion_{job_id}.csv"'},
    )


@router.get(
    "/jobs/{job_id}/csv.zip",
    summary="ZIP con un CSV por documento",
    description=(
        "Descarga un ZIP con un CSV por documento analizado (\u00fatil cuando se "
        "proces\u00f3 m\u00e1s de un archivo y se quieren CSV separados)."
    ),
    responses={
        200: {"description": "ZIP de CSVs", "content": {"application/zip": {}}},
        404: {"description": "El trabajo no existe"},
        409: {"description": "El trabajo a\u00fan no ha terminado"},
    },
)
def get_job_csv_zip(job_id: str) -> Response:
    """Devuelve un ZIP con un CSV por documento como descarga."""
    try:
        zip_bytes = analysis_controller.get_csv_zip(job_id)
    except analysis_controller.NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except analysis_controller.NotReadyError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="codificacion_{job_id}.zip"'},
    )
