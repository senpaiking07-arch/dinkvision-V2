const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = ["schemaVersion", "type", "tenantId", "entityId", "eventId", "version", "occurredAt"];

export type RecordingTransition = {
  schemaVersion: 1;
  type: "recording.transition";
  tenantId: string;
  entityId: string;
  eventId: string;
  version: number;
  occurredAt: string;
};

// A valid hint schedules an authorized snapshot read. Only that read sets UI state.
export function isNewRecordingTransition(value: unknown, tenant: string, lastVersion: number): value is RecordingTransition {
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length) return false;
  const e = value as Record<string, unknown>;
  return fields.every(field => Object.hasOwn(e, field))
    && e.schemaVersion === 1 && e.type === "recording.transition"
    && e.tenantId === tenant && uuid.test(tenant)
    && typeof e.entityId === "string" && uuid.test(e.entityId)
    && typeof e.eventId === "string" && uuid.test(e.eventId)
    && typeof e.version === "number" && Number.isSafeInteger(e.version) && e.version > Math.max(0, lastVersion)
    && typeof e.occurredAt === "string" && e.occurredAt.length <= 35
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(e.occurredAt)
    && Number.isFinite(Date.parse(e.occurredAt));
}
