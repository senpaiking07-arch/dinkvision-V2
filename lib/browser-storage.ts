export type LocalRecording = {
  id: string;
  jobId?: string;
  mime: string;
  complete: boolean;
  interrupted: boolean;
  createdAt: number;
  deviceId: string;
  expectAudio?: boolean;
  courtId?: string;
  bytes?: number;
  durationMs?: number;
  status?:
    | "saved_locally"
    | "pending"
    | "uploading"
    | "retrying"
    | "uploaded"
    | "failed";
  progress?: number;
  retryCount?: number;
  lastError?: string;
  nextRetryAt?: number;
  serverRetryRequired?: boolean;
  serverUploadReference?: string;
  localAvailable?: boolean;
  sourceSessionId?: string;
  validationFailed?: boolean;
  dismissedFromPlayer?: boolean;
  failureReportPending?: boolean;
  failureServerUpdatedAt?: number;
  clipStartMs?: number;
};
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("casa-browser-recordings", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("meta", { keyPath: "id" });
      r.result.createObjectStore("chunks", { keyPath: ["id", "index"] });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(
        Error("Local storage is unavailable. Do not use private browsing."),
      );
  });
}
async function transaction<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode),
      r = run(t.objectStore(store));
    t.oncomplete = () => {
      db.close();
      resolve(r.result);
    };
    t.onabort = () => {
      db.close();
      reject(Error("Could not save video locally. Storage may be full."));
    };
    t.onerror = () => {};
  });
}
export const saveMeta = (m: LocalRecording) =>
  transaction("meta", "readwrite", (s) => s.put(m));
export const getMeta = (id: string) =>
  transaction<LocalRecording | undefined>("meta", "readonly", (s) => s.get(id));
export const listMeta = () =>
  transaction<LocalRecording[]>("meta", "readonly", (s) => s.getAll());
export async function patchMeta(id: string, fields: Partial<LocalRecording>) {
  const current = await getMeta(id);
  if (!current) return;
  await saveMeta({ ...current, ...fields, id: current.id });
}
export const saveChunk = (id: string, index: number, blob: Blob) =>
  transaction("chunks", "readwrite", (s) => s.put({ id, index, blob }));
export async function savedVideo(id: string, mime: string) {
  const chunks = await transaction<{ id: string; index: number; blob: Blob }[]>(
    "chunks",
    "readonly",
    (s) => s.getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
  );
  return new Blob(
    chunks.map((c) => c.blob),
    { type: mime },
  );
}
export async function savedVideoRange(id: string, start: number, end: number) {
  const chunks = await transaction<{ id: string; index: number; blob: Blob }[]>(
    "chunks",
    "readonly",
    (s) => s.getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
  );
  const parts: Blob[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const chunkEnd = offset + chunk.blob.size;
    if (chunkEnd > start && offset < end)
      parts.push(chunk.blob.slice(Math.max(0, start - offset), Math.min(chunk.blob.size, end - offset)));
    offset = chunkEnd;
    if (offset >= end) break;
  }
  return new Blob(parts);
}
export async function removeVideoData(id: string) {
  await transaction("chunks", "readwrite", (s) =>
    s.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
  );
}
export async function removeVideo(id: string) {
  await removeVideoData(id);
  await transaction("meta", "readwrite", (s) => s.delete(id));
}
