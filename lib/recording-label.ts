type LabelSession = {
  started_at?: string | null;
  created_at?: string | null;
  recipient_email?: string | null;
  configuration_snapshot?: {
    recipient_emails?: unknown;
    venue_time_zone?: string;
  } | null;
};

export function recordingDisplayLabel(session?: LabelSession | null, fallbackDate?: string, zone = "Asia/Manila") {
  const configured = session?.configuration_snapshot?.recipient_emails;
  const recipients = [...new Set((Array.isArray(configured) && configured.length
    ? configured : [session?.recipient_email])
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map(value => value.trim()))];
  const value = [session?.created_at, session?.started_at, fallbackDate]
    .find(candidate => candidate && Number.isFinite(new Date(candidate).getTime()));
  let date = "Date unavailable";
  if (value) {
    const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
    try { date = new Intl.DateTimeFormat("en-PH", { ...options, timeZone: session?.configuration_snapshot?.venue_time_zone || zone }).format(new Date(value)); }
    catch { date = new Intl.DateTimeFormat("en-PH", { ...options, timeZone: "UTC" }).format(new Date(value)); }
  }
  const first = recipients[0] || "Players not recorded";
  const compact = first.length > 36 ? `${first.slice(0, 21)}…${first.slice(-12)}` : first;
  return {
    date,
    recipients: recipients.length > 1 ? `${compact} +${recipients.length - 1} more` : compact,
    full: `${date} · ${recipients.length ? recipients.join(", ") : first}`,
  };
}
