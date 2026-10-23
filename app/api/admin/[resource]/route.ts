import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, sameOrigin, readBody } from "@/lib/http";
import {
  bool,
  cameraInput,
  InputError,
  settingsInput,
  text,
  uuid,
} from "@/lib/validation";

export async function POST(
  request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const { account } = await getAccount();
    if (!account) return json({ error: "Please sign in again." }, 401);
    if (account.role !== "admin")
      return json({ error: "Administrator access is required." }, 403);
    const { resource } = await context.params;
    if (!["courts", "cameras", "recorders", "settings"].includes(resource))
      return json({ error: "Not found." }, 404);
    const body = await readBody(request);
    const db = resource === "settings" ? await serverSupabase() : (await import("@/lib/recorder-server")).systemDatabase();
    let result;
    if (resource === "settings") {
      result = await db
        .from("venue_settings")
        .update(settingsInput(body))
        .eq("tenant_id", account.tenantId)
        .eq("id", true)
        .select("id")
        .single();
    } else {
      let values: Record<string, unknown>;
      if (resource === "courts") {
        if (
          typeof body.location !== "string" ||
          body.location.trim().length > 150
        )
          throw new InputError("Location must be 150 characters or less.");
        values = {
          name: text(body.name, "Court name"),
          location: body.location.trim(),
          active: bool(body.active),
          tenant_id: account.tenantId,
        };
      } else if (resource === "cameras") {
        values = { ...cameraInput(body), tenant_id: account.tenantId };
      } else {
        values = { name: text(body.name, "Recorder name"), tenant_id: account.tenantId };
      }
      result = body.id
        ? await db
            .from(resource)
            .update(values)
            .eq("tenant_id", account.tenantId)
            .eq("id", uuid(body.id))
            .select("id")
            .single()
        : await db.from(resource).insert(values).select("id").single();
    }
    if (result.error) {
      const code = result.error.code;
      return json(
        {
          error:
            code === "23505"
              ? "That name or device already exists, or the court already has a primary camera. Edit the existing entry first."
              : code === "23514"
                ? "This change is invalid or a recording is active. Check the settings and try again."
                : code === "23503"
                  ? "The selected court or recorder no longer exists."
                  : "Could not save this change. Check that database setup is complete and try again.",
        },
        400,
      );
    }
    return json({ ok: true, id: result.data.id });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "The service is temporarily unavailable.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const { account } = await getAccount();
    if (!account) return json({ error: "Please sign in again." }, 401);
    if (account.role !== "admin")
      return json({ error: "Administrator access is required." }, 403);
    const { resource } = await context.params;
    if (resource !== "courts") return json({ error: "Not found." }, 404);
    const body = await readBody(request);
    const id = uuid(body.id);
    const db = (await import("@/lib/recorder-server")).systemDatabase();
    const court = await db
      .from("courts")
      .select("id,name")
      .eq("tenant_id", account.tenantId)
      .eq("id", id)
      .maybeSingle();
    if (court.error) throw court.error;
    if (!court.data) return json({ error: "This court no longer exists." }, 404);
    const removed = await db.from("courts").delete().eq("tenant_id", account.tenantId).eq("id", id);
    if (removed.error) {
      return json(
        {
          error:
            removed.error.code === "P0001"
              ? removed.error.message
              : removed.error.code === "23503"
                ? "Apply the latest database migration before removing courts."
                : "Could not permanently remove this court.",
        },
        409,
      );
    }
    await recorderDatabase().from("audit_events").insert({
      actor_id: account.id,
      action: "court.removed",
      safe_detail: { court_id: id, court_name: court.data.name },
    });
    return json({ ok: true, removed: true });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "The service is temporarily unavailable.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
