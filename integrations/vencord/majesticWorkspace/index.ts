/* Majestic Workspace: private Vencord userplugin, selected guilds only. */
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { ChannelStore, GuildStore, PermissionStore, PermissionsBits, RestAPI, UserStore } from "@webpack/common";
import { Collector } from "./collector";

const Native = VencordNative.pluginHelpers.MajesticWorkspace as PluginNative<typeof import("./native")>;
const defaults = "1317165120128028773,1525821262054817842";
const settings = definePluginSettings({
    origin: { type: OptionType.STRING, description: "Majestic Workspace URL (HTTPS, or http://127.0.0.1:15377 locally)", default: "https://apimjd.wispbyte.app" },
    credential: { type: OptionType.STRING, description: "DISCORD_BRIDGE_TOKEN from your Workspace configuration. This is NOT your Discord token.", default: "" },
    guildIds: { type: OptionType.STRING, description: "Only these guild IDs, comma separated. Empty means export nothing.", default: defaults },
    enabled: { type: OptionType.BOOLEAN, description: "Enable selected-guild synchronization", default: true }
});
const clientId = crypto.randomUUID();
let collector: any, timer: ReturnType<typeof setInterval> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
let busy = false, flushing = false, generation = 0;
const pending = new Map<string, { guildId: string; channelId: string; id: string; deleted: boolean }>();
const ids = () => settings.store.guildIds.split(/[\s,]+/).filter(x => /^\d{15,22}$/.test(x));
function permitted(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    return !!channel && ids().includes(channel.guild_id) && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel);
}
async function bridge(action: string, body: unknown) {
    const response = await Native.call(settings.store.origin, settings.store.credential, action, body);
    if (!response.ok) throw Object.assign(new Error(response.error?.code || "BRIDGE_ERROR"), { code: response.error?.code || "BRIDGE_ERROR", status: response.status, retryAfter: response.retryAfter });
    return response.data;
}
async function discord(route: string, query: object = {}) {
    try { return (await RestAPI.get({ url: route, query, retries: 0 })).body; }
    catch (e: any) { throw Object.assign(new Error("DISCORD_REQUEST_FAILED"), { status: e.status, retryAfter: e.body?.retry_after, code: "DISCORD_UNAVAILABLE" }); }
}
function createCollector() {
    const configuration = JSON.stringify([settings.store.origin, settings.store.credential, ids()]);
    const instance = new Collector({
        bridge, discord, clientId, guildIds: ids(), channelIds: [],
        isEnabled: () => settings.store.enabled && configuration === JSON.stringify([settings.store.origin, settings.store.credential, ids()]),
        guild: (id: string) => GuildStore.getGuild(id), channel: (id: string) => ChannelStore.getChannel(id),
        canView: (raw: any) => { const c = ChannelStore.getChannel(raw.id); return !!c && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, c); },
        canRead: (raw: any) => { const c = ChannelStore.getChannel(raw.id) || ChannelStore.getChannel(raw.parent_id); return !!c && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, c) && PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, c); },
        canManageThreads: (raw: any) => { const c = ChannelStore.getChannel(raw.id); return !!c && PermissionStore.can(PermissionsBits.MANAGE_THREADS, c); }
    });
    return instance;
}
function queueEvent(event: any, deleted = false) {
    if (!settings.store.enabled) return;
    const m = event.message || event, channelId = m.channel_id || event.channelId, id = m.id || event.id;
    if (!channelId || !id || !permitted(channelId)) return;
    const guildId = ChannelStore.getChannel(channelId).guild_id;
    if (pending.size < 1000 || pending.has(id)) pending.set(id, { guildId, channelId, id, deleted });
    else console.warn("[MajesticWorkspace] EVENT_QUEUE_FULL: run a full reconciliation after the export");
}
async function flushEvents() {
    if (flushing || !collector || !settings.store.enabled || !settings.store.credential) return;
    flushing = true;
    try {
        for (const [key, item] of [...pending].slice(0,25)) {
            if (!permitted(item.channelId)) { pending.delete(key); continue; }
            let message;
            if (!item.deleted) {
                try { message = await collector.get(`/channels/${item.channelId}/messages/${item.id}`); }
                catch (e: any) { if (e.status === 404) item.deleted = true; else if (e.status === 403) { pending.delete(key); continue; } else throw e; }
            }
            try {
                await bridge("events", { guildId: item.guildId, channelId: item.channelId, items: [item.deleted ? { type: "delete", id: item.id } : { type: "upsert", message }] });
                if (pending.get(key) === item) pending.delete(key);
            } catch (e: any) { if (e.code === "CHANNEL_FORBIDDEN" || e.code === "GUILD_FORBIDDEN") pending.delete(key); else throw e; }
        }
    } finally { flushing = false; }
}
async function tick() {
    if (busy || !settings.store.enabled || !settings.store.credential || !ids().length || !UserStore.getCurrentUser()) return;
    busy = true; const current = generation;
    collector = createCollector();
    try { await collector.run(); if (current === generation) await flushEvents(); }
    catch (e: any) { if (e.code !== "STOPPED") console.warn("[MajesticWorkspace]", e.code || "BRIDGE_UNAVAILABLE"); }
    finally { busy = false; }
}
export default definePlugin({
    name: "MajesticWorkspace",
    description: "Export only selected guilds to your own Workspace: MCP requests, resumable full history and periodic updates.",
    authors: [{ name: "igr0m", id: 0n }], settings,
    start() {
        generation++;
        timer = setInterval(() => { tick(); flushEvents().catch(() => {}); }, 10000);
        heartbeat = setInterval(() => { if (settings.store.enabled && settings.store.credential && ids().length && UserStore.getCurrentUser()) bridge("claim", { clientId, guildIds: ids() }).catch(() => {}); }, 20000);
        tick();
    },
    stop() { generation++; clearInterval(timer); clearInterval(heartbeat); collector?.stop(); pending.clear(); },
    flux: {
        MESSAGE_CREATE: (event: any) => queueEvent(event),
        MESSAGE_UPDATE: (event: any) => queueEvent(event),
        MESSAGE_DELETE: (event: any) => queueEvent(event, true),
        MESSAGE_DELETE_BULK: (event: any) => { for (const id of event.ids || []) queueEvent({ id, channelId: event.channelId }, true); },
        LOGOUT: () => { collector?.stop(); pending.clear(); }
    }
});
