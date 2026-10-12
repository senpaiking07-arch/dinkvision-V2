import test from "node:test";
import assert from "node:assert/strict";
import {
  googleRedirectUri,
  LOCAL_GOOGLE_REDIRECT_URI,
  PRODUCTION_GOOGLE_REDIRECT_URI,
} from "../lib/google-redirect";

test("Google OAuth uses stable defaults for deployed and local builds", () => {
  assert.equal(googleRedirectUri({}), LOCAL_GOOGLE_REDIRECT_URI);
  assert.equal(
    googleRedirectUri({ VERCEL: "1", VERCEL_ENV: "production" }),
    PRODUCTION_GOOGLE_REDIRECT_URI,
  );
  assert.equal(
    googleRedirectUri({ NODE_ENV: "production" }),
    PRODUCTION_GOOGLE_REDIRECT_URI,
  );
});

test("Google OAuth accepts exact stable production and localhost callbacks", () => {
  assert.equal(
    googleRedirectUri({
      VERCEL: "1",
      GOOGLE_REDIRECT_URI: PRODUCTION_GOOGLE_REDIRECT_URI,
    }),
    PRODUCTION_GOOGLE_REDIRECT_URI,
  );
  assert.equal(
    googleRedirectUri({ GOOGLE_REDIRECT_URI: LOCAL_GOOGLE_REDIRECT_URI }),
    LOCAL_GOOGLE_REDIRECT_URI,
  );
  assert.equal(
    googleRedirectUri({
      GOOGLE_REDIRECT_URI:
        "http://localhost:3000/api/integrations/google/callback",
    }),
    "http://localhost:3000/api/integrations/google/callback",
  );
});

test("Google OAuth rejects generated deployment domains and incorrect callback paths", () => {
  for (const GOOGLE_REDIRECT_URI of [
    "https://picklecamera-7olo1kmbl-renrenpedrajetas-projects.vercel.app/api/integrations/google/callback",
    "https://dinkvision.vercel.app/",
    "https://dinkvision.vercel.app/api/integrations/google/callback/",
    "https://dinkvision.vercel.app/api/integrations/google/callback?source=preview",
  ])
    assert.throws(
      () => googleRedirectUri({ VERCEL: "1", GOOGLE_REDIRECT_URI }),
      /google_redirect_invalid/,
    );
});
