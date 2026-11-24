/* Majestic Workspace userplugin. No Discord account credentials are read here. */
import type { IpcMainInvokeEvent } from "electron";

const paths: Record<string, string> = {
    claim: "/api/discord/bridge/claim",
    batch: "/api/discord/bridge/batch",
    events: "/api/discord/bridge/events"
};

export async function call(_event: IpcMainInvokeEvent, origin: string, credential: string, action: string, body: unknown) {
    const url = new URL(origin);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
        || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !paths[action])
        throw new Error("BRIDGE_ORIGIN: configure an HTTPS origin or local 127.0.0.1");
    if (typeof credential !== "string" || credential.length < 32 || credential.length > 256)
        throw new Error("BRIDGE_CREDENTIAL: configure the separate application credential");
    const data = JSON.stringify(body);
    if (Buffer.byteLength(data) > 900000) throw new Error("EXPORT_BATCH_SIZE");
    const response = await fetch(new URL(paths[action], url), {
        method: "POST", headers: { authorization: "Bearer " + credential, "content-type": "application/json" },
        body: data, redirect: "error", signal: AbortSignal.timeout(15000)
    });
    // Return structured errors: Electron IPC otherwise discards custom Error properties.
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 1048576) return { ok: false, status: 502, error: { code: "BRIDGE_RESPONSE_SIZE" } };
    let result;
    try { result = JSON.parse(raw); } catch { return { ok: false, status: response.status, error: { code: "BRIDGE_FORMAT" } }; }
    return { ...result, status: response.status, retryAfter: Number(response.headers.get("retry-after")) || 0 };
}
