import { PluginType } from "./types";

export interface PluginConfig {
    readonly pluginName: string;
    readonly pluginType: PluginType;
    readonly version: string;
    readonly description?: string;
    readonly commands: string[];
}