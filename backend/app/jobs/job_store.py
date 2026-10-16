"""Almacén en memoria del estado, progreso y resultado de los trabajos.

Para el MVP el estado vive en memoria del proceso (se pierde al reiniciar). Está
aislado tras esta clase para poder migrarlo luego a un almacén persistente
(Redis, base de datos) sin tocar el resto del backend.

El acceso está protegido por un lock porque la codificación corre en un hilo de
fondo mientras las rutas leen el estado desde el hilo del servidor.
"""
from __future__ import annotations

import threading
import uuid
from typing import Dict, Optional

from app.models.results import JobState, JobStatus, Result


class _JobRecord:
    """Registro interno de un trabajo: su estado y (al terminar) su resultado."""

    def __init__(self, job_id: str) -> None:
        self.status = JobStatus(job_id=job_id, state=JobState.pending, progress=0.0)
        self.result: Optional[Result] = None
        # Bandera de cancelación cooperativa: el pipeline la consulta y se detiene.
        self.cancel_requested = False


class JobStore:
    """Almacén thread-safe de trabajos de codificación."""

    def __init__(self) -> None:
        self._jobs: Dict[str, _JobRecord] = {}
        self._lock = threading.Lock()

    def create(self) -> str:
        """Crea un trabajo nuevo en estado ``pending`` y devuelve su ID."""
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = _JobRecord(job_id)
        return job_id

    def set_running(self, job_id: str) -> None:
        """Marca un trabajo como ``running``."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec:
                rec.status.state = JobState.running

    def update_progress(self, job_id: str, progress: float, message: str = "") -> None:
        """Actualiza el progreso (0..1) y el mensaje de un trabajo en curso."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec:
                rec.status.progress = max(0.0, min(1.0, progress))
                if message:
                    rec.status.message = message

    def set_done(self, job_id: str, result: Result) -> None:
        """Marca un trabajo como ``done`` y guarda su resultado."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec:
                rec.status.state = JobState.done
                rec.status.progress = 1.0
                rec.status.message = "Completado"
                rec.result = result

    def set_error(self, job_id: str, error: str) -> None:
        """Marca un trabajo como ``error`` y guarda el detalle."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec:
                rec.status.state = JobState.error
                rec.status.error = error
                rec.status.message = "Error"

    def request_cancel(self, job_id: str) -> bool:
        """Solicita cancelar un trabajo en curso (cancelación cooperativa).

        Returns:
            True si el trabajo existe y estaba en un estado cancelable
            (pending/running); False en caso contrario.
        """
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec is None:
                return False
            if rec.status.state in (JobState.pending, JobState.running):
                rec.cancel_requested = True
                return True
            return False

    def is_cancel_requested(self, job_id: str) -> bool:
        """Indica si se pidió cancelar el trabajo."""
        with self._lock:
            rec = self._jobs.get(job_id)
            return bool(rec and rec.cancel_requested)

    def set_cancelled(self, job_id: str) -> None:
        """Marca un trabajo como ``cancelled``."""
        with self._lock:
            rec = self._jobs.get(job_id)
            if rec:
                rec.status.state = JobState.cancelled
                rec.status.message = "Cancelado"

    def get_status(self, job_id: str) -> Optional[JobStatus]:
        """Devuelve el estado de un trabajo, o ``None`` si no existe."""
        with self._lock:
            rec = self._jobs.get(job_id)
            return rec.status if rec else None

    def get_result(self, job_id: str) -> Optional[Result]:
        """Devuelve el resultado de un trabajo terminado, o ``None`` si no lo hay."""
        with self._lock:
            rec = self._jobs.get(job_id)
            return rec.result if rec else None

    def exists(self, job_id: str) -> bool:
        """Indica si existe un trabajo con ese ID."""
        with self._lock:
            return job_id in self._jobs


# Instancia única compartida por la app (inyectable/reemplazable en pruebas).
job_store = JobStore()
