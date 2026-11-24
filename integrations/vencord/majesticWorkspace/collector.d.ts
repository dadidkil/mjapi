export class Collector {
    constructor(options: Record<string, any>);
    stopped: boolean;
    guildIds: string[];
    channelIds: string[];
    stop(): void;
    get(route: string, query?: object): Promise<any>;
    claim(): Promise<any>;
    run(): Promise<{ id: string; state: string } | null>;
}
export function batches(items: any[], maxBytes?: number): any[][];
export function errorCode(error: any): string;
