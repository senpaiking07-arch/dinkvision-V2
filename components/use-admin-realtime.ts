"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import type { AdminData } from "@/lib/admin-types";
import { isNewRecordingTransition } from "@/lib/recording-transition";

type Snapshot = Pick<AdminData, "courts" | "settings" | "sessions" | "captureReports">;
export type RealtimeScope = { tenantId: string; accountId: string };

export function useAdminRealtime(initial: Snapshot, scope: RealtimeScope | undefined, recording: string, onAccessChanged: () => void) {
  const [latest, setLatest] = useState<{ initial: Snapshot; data: Snapshot }>();
  const [stale, setStale] = useState(false);
  const [deniedInitial, setDeniedInitial] = useState<Snapshot>();
  const tenantId = scope?.tenantId;
  const accountId = scope?.accountId;

  useEffect(() => {
    if (!tenantId || !accountId) return;
    const tenant = tenantId;
    const query = new URLSearchParams({ tenant, account: accountId, recording });
    const url = `/api/admin/dashboard-snapshot?${query}`;
    const config = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
    let stopActive: (() => void) | undefined;
    let accessChanged = false;
    let initialActivation = true;

    function syncAvailability() {
      if (document.hidden || !navigator.onLine) {
        stopActive?.();
        stopActive = undefined;
        setStale(true);
      } else if (!stopActive && !accessChanged) {
        stopActive = activate();
      }
    }

    function activate() {
      const life = new AbortController();
      let socket: ReturnType<typeof createClient>["realtime"] | undefined;
      let poll: ReturnType<typeof setTimeout>;
      let retry: ReturnType<typeof setTimeout>;
      let joined = false;
      let joinedAt = 0;
      let failures = 0;
      let version = 0;
      let reading = false;
      let dirty = false;
      let lastRead = 0;

      const stop = () => {
        life.abort();
        clearTimeout(poll);
        clearTimeout(retry);
        closeSocket();
      };

      function closeSocket() {
        joined = false;
        const old = socket;
        socket = undefined;
        if (old) {
          for (const channel of old.getChannels()) channel.teardown();
          void old.disconnect().catch(() => {});
        }
      }

      async function request(method: "GET" | "POST") {
        const res = await fetch(url, {
          method, cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([life.signal, AbortSignal.timeout(12000)]),
        });
        if (life.signal.aborted) return;
        if ([401, 403, 404].includes(res.status)) {
          accessChanged = true;
          setDeniedInitial(initial);
          setLatest(undefined);
          setStale(true);
          stop();
          onAccessChanged();
          return;
        }
        if (!res.ok) throw new Error("Dashboard synchronization unavailable");
        return res;
      }

      function schedule(delay: number) {
        clearTimeout(poll);
        poll = setTimeout(() => void reconcile(), delay);
      }

      function invalidate() {
        dirty = true;
        if (!reading) schedule(Math.max(0, 5000 - (Date.now() - lastRead)));
      }

      async function reconcile() {
        if (life.signal.aborted || reading) return;
        reading = true;
        dirty = false;
        lastRead = Date.now();
        try {
          const data = await (await request("GET"))?.json() as Snapshot | undefined;
          if (life.signal.aborted || !data) return;
          setLatest({ initial, data });
          setStale(false);
        } catch {
          if (!life.signal.aborted) setStale(true);
        } finally {
          reading = false;
          if (!life.signal.aborted) {
            if (dirty) invalidate();
            else schedule(joined ? 60000 : 30000);
          }
        }
      }

      function reconnect() {
        const wasJoined = joined;
        if (wasJoined && Date.now() - joinedAt >= 60000) failures = 0;
        closeSocket();
        clearTimeout(retry);
        if (wasJoined) invalidate();
        // Keep polling after sustained failures. Foreground or network recovery
        // starts a fresh activation with its own retry budget.
        if (failures >= 5) return;
        // Jitter each attempt so foreground tabs do not all retry together.
        const delay = 2000 * 2 ** failures++;
        retry = setTimeout(() => void connect(), delay * (0.5 + Math.random() * 0.5));
      }

      async function connect() {
        if (!config.url || !config.key || life.signal.aborted) return;
        try {
          const credentials = await (await request("POST"))?.json();
          if (life.signal.aborted || !credentials) return;
          const { accessToken, expiresAt } = credentials;
          if (typeof accessToken !== "string" || !Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now() + 1000) {
            throw new Error("Realtime credentials unavailable");
          }
          const client = createClient(config.url, config.key, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          });
          socket = client.realtime;
          await client.realtime.setAuth(accessToken);
          if (life.signal.aborted || socket !== client.realtime) return;
          client.channel(`tenant:${tenant}:admin-status`, { config: { private: true } })
            .on("broadcast", { event: "recording.transition" }, ({ payload }) => {
              if (socket !== client.realtime || !joined || !isNewRecordingTransition(payload, tenant, version)) return;
              version = payload.version;
              invalidate();
            })
            .subscribe(status => {
              if (life.signal.aborted || socket !== client.realtime) return;
              if (status !== "SUBSCRIBED") {
                reconnect();
                return;
              }
              joined = true;
              joinedAt = Date.now();
              invalidate();
              clearTimeout(retry);
              // Rejoin with current credentials and re-check membership periodically.
              const renewIn = Math.min(270000 + Math.random() * 30000, expiresAt * 1000 - Date.now());
              retry = setTimeout(() => {
                if (Date.now() - joinedAt >= 60000) failures = 0;
                closeSocket();
                void connect();
              }, Math.max(0, renewIn));
            });
        } catch {
          if (!life.signal.aborted) reconnect();
        }
      }

      if (initialActivation) {
        // The server just supplied an authorized snapshot. A successful join
        // reconciles immediately, and polling covers a slow or rejected join.
        schedule(30000);
        void connect();
      } else {
        void reconcile().then(connect);
      }
      return stop;
    }

    document.addEventListener("visibilitychange", syncAvailability);
    window.addEventListener("online", syncAvailability);
    window.addEventListener("offline", syncAvailability);
    syncAvailability();
    initialActivation = false;
    return () => {
      stopActive?.();
      document.removeEventListener("visibilitychange", syncAvailability);
      window.removeEventListener("online", syncAvailability);
      window.removeEventListener("offline", syncAvailability);
    };
  }, [initial, tenantId, accountId, recording, onAccessChanged]);

  return { data: latest?.initial === initial && scope ? latest.data : initial, stale: Boolean(scope) && stale, accessLost: Boolean(scope) && deniedInitial === initial };
}
