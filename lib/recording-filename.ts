import { uuidPattern } from "./validation";

type RecordingStart = {
  started_at?: string | null;
  venue_time_zone?: string | null;
};

export type RecordingFilenameMetadata = {
  id?: string;
  session_id?: string;
  recording_sessions?: RecordingStart | RecordingStart[] | null;
};

function recordedStamp(startedAt: string, timeZone: string) {
  const date = new Date(startedAt);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(startedAt) || !Number.isFinite(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZone,
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", options);
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}

export function recordingDownloadFilename(file: RecordingFilenameMetadata) {
  const id = [file.id, file.session_id].find(value => value && uuidPattern.test(value));
  if (!id) return "dinkvision-replay.mp4";
  const session = Array.isArray(file.recording_sessions) ? file.recording_sessions[0] : file.recording_sessions;
  const stamp = session?.started_at && recordedStamp(session.started_at, session.venue_time_zone || "UTC");
  return `${stamp || "dinkvision-replay"}_${id.toLowerCase()}.mp4`;
}
