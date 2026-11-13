type QueryResult = { error: { code?: string; message?: string } | null };

export const captureColumns = ["capture_interruption_code", "capture_interrupted_at", "capture_inspection_required"];
export const qrColumns = ["enrollment_qr_hash", "enrollment_qr_failures"];
export const retryColumns = ["upload_retry_at"];

export function missingColumns(error: QueryResult["error"], columns: readonly string[]) {
  return !!error && ["42703", "PGRST204"].includes(error.code || "") &&
    columns.some(column => error.message?.includes(column));
}

export async function withOptionalColumns<T extends QueryResult, U extends QueryResult>(
  preferred: () => PromiseLike<T>, legacy: () => PromiseLike<U>, columns: readonly string[],
) {
  const result = await preferred();
  return missingColumns(result.error, columns) ? legacy() : result;
}

export async function readRecorderQueue<T extends QueryResult>(
  read: (captureDetails: boolean, retrySchedule: boolean) => PromiseLike<T>,
  includeRetrySchedule: boolean,
) {
  let captureDetails = true;
  let retrySchedule = includeRetrySchedule;
  while (true) {
    const result = await read(captureDetails, retrySchedule);
    if (captureDetails && missingColumns(result.error, captureColumns)) {
      captureDetails = false;
    } else if (retrySchedule && missingColumns(result.error, retryColumns)) {
      retrySchedule = false;
    } else {
      return {result, retrySchedule};
    }
  }
}
