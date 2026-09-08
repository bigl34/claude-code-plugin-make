
import { loadServiceConfig, z } from "@local/cli-utils";

const MakeRestEnvSchema = z
  .object({
    MAKE_API_KEY: z.string().min(1),
    MAKE_ZONE: z.string().min(1),
    MAKE_TEAM: z.string().min(1),
  })
  .catchall(z.string());

const MakeRestConfigSchema = z
  .object({
    mcpServer: z
      .object({
        command: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
        env: MakeRestEnvSchema,
      })
      .passthrough(),
  })
  .passthrough();

type JsonRecord = Record<string, unknown>;

export interface ScenarioSummary {
  id: string;
  name: string;
  isActive: boolean;
  isPaused: boolean;
  scheduling: string;
  hookId: string | null;
  dlqCount: number | null;
  lastEdit: string | null;
}

export interface NotionTarget {
  moduleId: string;
  module: string;
  dataSource: string | null;
}

export interface ScenarioBlueprint {
  id: string;
  triggerApp: string;
  modules: { id: string; module: string; label?: string }[];
  notionModules: string[];
  touchesNotion: boolean;
  notionTargets: NotionTarget[];
}

export class MakeRestClient {
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly teamId: string;

  constructor() {
    const config = loadServiceConfig("make-scenario-manager", {
      schema: MakeRestConfigSchema,
    });
    const env = config.mcpServer.env;
    const zone = normalizeZone(env.MAKE_ZONE);

    this.apiToken = env.MAKE_API_KEY;
    this.baseUrl = `https://${zone}/api/v2`;
    this.teamId = env.MAKE_TEAM;
  }

  async listScenarios(): Promise<ScenarioSummary[]> {
    const limit = 100;
    const maxPages = 50;
    const scenarios: ScenarioSummary[] = [];
    let offset = 0;

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const team = encodeURIComponent(this.teamId);
      const path = `/scenarios?teamId=${team}&pg[limit]=${limit}&pg[offset]=${offset}`;
      const page = await this.get<unknown>(path);
      const pageScenarios = extractScenarioList(page);
      const summaries = pageScenarios.map((scenario) => toScenarioSummary(scenario));

      scenarios.push(...summaries);

      if (pageScenarios.length < limit) {
        return scenarios;
      }

      offset += limit;
    }

    throw new Error(`Make listScenarios exceeded ${maxPages} pages — aborting to avoid an unbounded loop`);
  }

  async getScenario(id: string): Promise<ScenarioSummary> {
    const encodedId = encodeURIComponent(id);
    const payload = await this.get<unknown>(`/scenarios/${encodedId}`);
    const scenario = extractScenario(payload);

    return toScenarioSummary(scenario);
  }

  async getBlueprint(id: string): Promise<ScenarioBlueprint> {
    const encodedId = encodeURIComponent(id);
    const payload = await this.get<unknown>(`/scenarios/${encodedId}/blueprint`);
    const blueprint = extractBlueprint(payload);
    const flow = getArray(blueprint.flow);
    const rawModules: JsonRecord[] = [];

    collectFlowModules(flow, rawModules);

    const modules = rawModules.map((module) => toBlueprintModule(module));
    const notionModules = distinctStrings(
      modules
        .filter((module) => /notion/i.test(module.module))
        .map((module) => module.module),
    );
    const notionTargets = rawModules
      .filter((module) => isNotionModule(module))
      .map((module) => toNotionTarget(module));
    const triggerApp = modules[0]?.module ?? "";

    return {
      id,
      triggerApp,
      modules,
      notionModules,
      touchesNotion: notionModules.length > 0,
      notionTargets,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: ctrl.signal,
        headers: {
          Authorization: `Token ${this.apiToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`Make API ${response.status} for ${path}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeZone(zone: string): string {
  const withoutProtocol = zone.replace(/^https?:\/\//, "");
  const withoutTrailingSlash = withoutProtocol.replace(/\/+$/, "");

  return withoutTrailingSlash;
}

function normalizeScheduling(raw: unknown): string {
  const parsed = parseScheduling(raw);
  const record = toRecord(parsed);

  if (!record) {
    return String(parsed ?? "");
  }

  const type = toNullableString(record.type);

  if (!type) {
    return JSON.stringify(record);
  }

  if (type === "immediately") {
    return "immediately";
  }

  if (type === "indefinitely") {
    const interval = toNullableNumber(record.interval);

    if (interval !== null) {
      return `interval:${interval}s`;
    }
  }

  if (isOnDemandType(type)) {
    return "on-demand";
  }

  return type;
}

function parseScheduling(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return "";
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function isOnDemandType(type: string): boolean {
  const normalized = type.toLowerCase().replace(/[\s_-]+/g, "");

  return normalized === "ondemand";
}

function extractScenarioList(payload: unknown): JsonRecord[] {
  const root = toRecord(payload);
  const response = toRecord(root?.response);
  const scenarios = getArray(root?.scenarios ?? response?.scenarios);

  return scenarios.flatMap((scenario) => {
    const record = toRecord(scenario);

    return record ? [record] : [];
  });
}

function extractScenario(payload: unknown): JsonRecord {
  const root = toRecord(payload);
  const response = toRecord(root?.response);
  const scenario = toRecord(root?.scenario);
  const responseScenario = toRecord(response?.scenario);
  const responseRecord = response && !Array.isArray(response) ? response : null;

  return scenario ?? responseScenario ?? responseRecord ?? root ?? {};
}

function extractBlueprint(payload: unknown): JsonRecord {
  const root = toRecord(payload);
  const response = toRecord(root?.response);
  const blueprint = toRecord(root?.blueprint);
  const responseBlueprint = toRecord(response?.blueprint);

  return responseBlueprint ?? blueprint ?? root ?? {};
}

function collectFlowModules(flow: unknown[], modules: JsonRecord[]): void {
  for (const item of flow) {
    const module = toRecord(item);

    if (!module) {
      continue;
    }

    const moduleName = toNullableString(module.module);

    if (moduleName) {
      modules.push(module);
    }

    const routes = getArray(module.routes);

    for (const route of routes) {
      const routeRecord = toRecord(route);
      const routeFlow = getArray(routeRecord?.flow);

      collectFlowModules(routeFlow, modules);
    }
  }
}

function toScenarioSummary(raw: JsonRecord): ScenarioSummary {
  const pausedValue = firstPresent(raw, ["isPaused", "ispaused"]);
  const activeValue = firstPresent(raw, ["isActive", "isactive"]);
  const isPaused = toNullableBoolean(pausedValue) ?? false;
  const isActive = toNullableBoolean(activeValue) ?? !isPaused;
  const dlqValue = firstPresent(raw, ["dlqCount", "dlqcount", "dlq_count"]);
  const hasDlq = hasAnyKey(raw, ["dlqCount", "dlqcount", "dlq_count"]);

  return {
    id: toNullableString(raw.id) ?? "",
    name: toNullableString(raw.name) ?? "",
    isActive,
    isPaused,
    scheduling: normalizeScheduling(raw.scheduling),
    hookId: toNullableString(firstPresent(raw, ["hookId", "hookid", "hook_id"])),
    dlqCount: hasDlq ? toNullableNumber(dlqValue) : null,
    lastEdit: toNullableString(firstPresent(raw, ["lastEdit", "lastedit", "last_edit"])),
  };
}

function toBlueprintModule(raw: JsonRecord): { id: string; module: string; label?: string } {
  const id = toNullableString(raw.id) ?? "";
  const module = toNullableString(raw.module) ?? "";
  const label = extractLabel(raw);

  if (!label) {
    return { id, module };
  }

  return { id, module, label };
}

function extractLabel(raw: JsonRecord): string | undefined {
  const metadata = toRecord(raw.metadata);
  const designer = toRecord(metadata?.designer);
  const label = toNullableString(raw.label);
  const designerName = toNullableString(designer?.name);
  const metadataName = toNullableString(metadata?.name);

  return label ?? designerName ?? metadataName ?? undefined;
}

function isNotionModule(raw: JsonRecord): boolean {
  const module = toNullableString(raw.module);

  return module !== null && /notion/i.test(module);
}

export function isNotionWriteModule(moduleName: string): boolean {
  const normalized = moduleName.toLowerCase();
  if (!normalized.includes("notion")) {
    return false;
  }
  return /(create|update|append|delete|insert|upsert|patch|write)/.test(normalized);
}

function toNotionTarget(raw: JsonRecord): NotionTarget {
  const mapper = toRecord(raw.mapper);
  const module = toNullableString(raw.module) ?? "";
  const databaseId = toNullableString(mapper?.databaseId);
  const database = toNullableString(mapper?.database);
  const dataSource = typeof mapper?.data_source === "string" ? mapper.data_source : null;

  return {
    moduleId: toNullableString(raw.id) ?? "",
    module,
    dataSource: databaseId ?? database ?? dataSource,
  };
}

function distinctStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function firstPresent(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }

  return undefined;
}

function hasAnyKey(record: JsonRecord, keys: string[]): boolean {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return true;
    }
  }

  return false;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toRecord(value: unknown): JsonRecord | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function toNullableString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  return null;
}
