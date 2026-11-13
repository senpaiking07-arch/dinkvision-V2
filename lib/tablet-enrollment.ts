export const pairingCode = /^[A-Za-z0-9_-]{12}$/;
export const legacyEnrollmentCode = /^[A-Za-z0-9_-]{24}$/;
export const enrollmentCode = /^(?:[A-Za-z0-9_-]{12}|[A-Za-z0-9_-]{24})$/;
export const enrollmentPin = /^[0-9]{6}$/;
export const qrEnrollmentPath = "/tablet/enroll";

export function qrVerifier(invite: string, pin: string) {
  return `qr-v1:${invite}:${pin}`;
}

export function pairingBrowserLinks(path: string, origin: string, android: boolean) {
  const page = new URL("/admin/pair-device", origin);
  const request = /^\/admin\/pair-device\?request=([0-9a-f-]{36})$/i.exec(path)?.[1];
  if (request && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request))
    page.searchParams.set("request", request);
  const external = android && page.protocol === "https:"
    ? `intent://${page.host}${page.pathname}${page.search}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(page.href)};end`
    : page.href;
  return { page: page.href, external };
}
