export const GOOGLE_CALLBACK_PATH = "/api/integrations/google/callback";
export const PRODUCTION_GOOGLE_REDIRECT_URI =
  `https://picklecamera.vercel.app${GOOGLE_CALLBACK_PATH}`;
export const LOCAL_GOOGLE_REDIRECT_URI =
  `http://127.0.0.1:3000${GOOGLE_CALLBACK_PATH}`;

type RedirectEnvironment = Partial<
  Record<"GOOGLE_REDIRECT_URI" | "NODE_ENV" | "VERCEL" | "VERCEL_ENV", string>
>;

export function googleRedirectUri(
  environment: RedirectEnvironment = process.env,
) {
  const isVercel =
    environment.VERCEL === "1" || Boolean(environment.VERCEL_ENV);
  const fallback =
    isVercel || environment.NODE_ENV === "production"
      ? PRODUCTION_GOOGLE_REDIRECT_URI
      : LOCAL_GOOGLE_REDIRECT_URI;
  const configured = environment.GOOGLE_REDIRECT_URI?.trim() || fallback;
  let redirect: URL;
  try {
    redirect = new URL(configured);
  } catch {
    throw new Error("google_redirect_invalid");
  }

  const localHost = ["127.0.0.1", "localhost"].includes(redirect.hostname);
  if (
    redirect.pathname !== GOOGLE_CALLBACK_PATH ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password ||
    (redirect.protocol !== "https:" && !(localHost && redirect.protocol === "http:")) ||
    (isVercel &&
      redirect.origin !== new URL(PRODUCTION_GOOGLE_REDIRECT_URI).origin)
  )
    throw new Error("google_redirect_invalid");

  return redirect.toString();
}
