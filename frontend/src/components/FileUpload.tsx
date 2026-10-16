// Subida de transcripciones .txt con arrastrar y soltar + selección manual.
// Valida el tipo de archivo y lee su contenido de texto.
import { useRef, useState } from "react";
import type { DocumentInput } from "../types";

interface FileUploadProps {
  documents: DocumentInput[];
  onChange: (docs: DocumentInput[]) => void;
}

/** Indica si un archivo es un .txt aceptable (por extensión o MIME). */
function isTxt(file: File): boolean {
  return file.name.toLowerCase().endsWith(".txt") || file.type === "text/plain";
}

export function FileUpload({ documents, onChange }: FileUploadProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  /** Lee una lista de archivos, valida y añade los .txt al estado. */
  async function ingest(files: FileList | null) {
    if (!files) return;
    setError(undefined);
    const accepted: DocumentInput[] = [];
    for (const file of Array.from(files)) {
      if (!isTxt(file)) {
        setError(`"${file.name}" no es un archivo TXT y se omitió.`);
        continue;
      }
      const content = await file.text();
      accepted.push({ name: file.name, content });
    }
    if (accepted.length === 0) return;
    // Evita duplicados por nombre (reemplaza el existente).
    const byName = new Map(documents.map((d) => [d.name, d]));
    for (const doc of accepted) byName.set(doc.name, doc);
    onChange(Array.from(byName.values()));
  }

  /** Quita un documento de la lista por nombre. */
  function remove(name: string) {
    onChange(documents.filter((d) => d.name !== name));
  }

  return (
    <div className="panel">
      <h2>Transcripciones</h2>

      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          ingest(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <p>Arrastra archivos .txt aquí o haz clic para seleccionar</p>
        <input
          ref={inputRef}
          type="file"
          accept=".txt,text/plain"
          multiple
          hidden
          onChange={(e) => ingest(e.target.files)}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {documents.length > 0 && (
        <ul className="file-list">
          {documents.map((doc) => (
            <li key={doc.name}>
              <span>{doc.name}</span>
              <button onClick={() => remove(doc.name)}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
