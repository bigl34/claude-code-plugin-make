#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MakeRestClient,
  isNotionWriteModule,
  type NotionTarget,
  type ScenarioBlueprint,
  type ScenarioSummary,
} from "./make-rest.js";

const HOUR_MS = 3_600_000;
const HOME = process.env.HOME ?? homedir();
const BIZ = process.env.BIZ_ROOT?.trim() || join(HOME, "biz");
const MAKE_HEALTH_STATE_DIR = process.env.MAKE_HEALTH_STATE_DIR?.trim()
  || join(BIZ, "var/make-health");
const MAKE_HEALTH_LOG_DIR = process.env.MAKE_HEALTH_LOG_DIR?.trim()
  || join(BIZ, "logs");
const SNAPSHOT_PATH = process.env.MAKE_HEALTH_SNAPSHOT_PATH?.trim()
  || join(BIZ, "reports/automation-catalog/make-latest.json");
const STATE_PATH = join(MAKE_HEALTH_STATE_DIR, "last-state.json");
const DECISION_LOG_PATH = join(MAKE_HEALTH_LOG_DIR, "make-health.jsonl");
const SLACK_CONFIG = process.env.MAKE_HEALTH_SLACK_CONFIG?.trim()
  || join(BIZ, "scripts/slack-manager/config.json");
const SLACK_CHANNEL = "YOUR_SLACK_ALERT_CHANNEL_ID";
const DEBOUNCE_MS = 12 * HOUR_MS;
const BLUEPRINT_POOL_SIZE = 4;
const LOG_PREFIX = "[make-health]";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const SHADOW_FIXTURE = shadowFixturePath(args);

interface MakeHealthShadowFixture {
  schema_version: 1;
  redacted: true;
  task_id: "make-health";
  captured_at: string;
  replay: {
    previous: HealthState;
    current: HealthState;
    scenario_names: Record<string, string>;
  };
  expected: {
    regression_rules: RegressionRule[];
    structural_drift_count: number;
  };
}

interface SnapshotScenario {
  id: string;
  name: string;
  isActive: boolean;
  scheduling: string;
  trigger: string;
  notionTargets: NotionTarget[];
  moduleHash: string;
}

interface ScenarioHealthState {
  isActive: boolean;
  dlqCount: number | null;
  touchesNotion: boolean;
  notionWriteTargetCount: number;
  moduleHash: string;
}

interface HealthState {
  updatedMs: number;
  alerts?: Record<string, number>;
  scenarios: Record<string, ScenarioHealthState>;
}

interface EnrichedScenario {
  summary: ScenarioSummary;
  blueprint: ScenarioBlueprint;
  orderedModuleNames: string[];
  moduleHash: string;
}

type DecisionEvent =
  | "first-run"
  | "no-regressions"
  | "alerted"
  | "debounced"
  | "dry-run"
  | "error";

type RegressionRule =
  | "active-to-inactive"
  | "dlq-increase"
  | "notion-writer-stopped";

interface Regression {
  id: string;
  name: string;
  rule: RegressionRule;
  before: string;
  after: string;
}

interface StructuralDrift {
  id: string;
  name: string;
  beforeModuleHash: string;
  afterModuleHash: string;
}

function writeIfChanged(outputPath: string, bytes: string): boolean {
  if (existsSync(outputPath) && readFileSync(outputPath, "utf8") === bytes) {
    return false;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, bytes, { mode: 0o644 });
    renameSync(tempPath, outputPath);
  } catch (err) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw err;
  }
  return true;
}

function readState(): HealthState | null {
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as HealthState;

    const scenarios = Object.values(parsed.scenarios ?? {});
    const isLegacyShape = scenarios.some(
      (scenario) => typeof (scenario as { notionWriteTargetCount?: unknown }).notionWriteTargetCount !== "number",
    );
    if (isLegacyShape) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeState(state: HealthState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n");
    renameSync(tempPath, STATE_PATH);
  } catch (err) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw err;
  }
}

function logDecision(entry: Record<string, unknown>): void {
  mkdirSync(dirname(DECISION_LOG_PATH), { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n";
  appendFileSync(DECISION_LOG_PATH, line);
}

function snapshotWouldChange(bytes: string): boolean {
  if (!existsSync(SNAPSHOT_PATH)) {
    return true;
  }

  const current = readFileSync(SNAPSHOT_PATH, "utf8");

  return current !== bytes;
}

export async function fetchFleet(rest: MakeRestClient): Promise<EnrichedScenario[]> {
  const summaries = await rest.listScenarios();
  const enriched = await mapWithConcurrency(
    summaries,
    BLUEPRINT_POOL_SIZE,
    async (summary): Promise<EnrichedScenario> => enrichScenario(rest, summary),
  );

  return enriched.sort(compareEnrichedScenarios);
}

async function enrichScenario(
  rest: MakeRestClient,
  summary: ScenarioSummary,
): Promise<EnrichedScenario> {
  const blueprint = await rest.getBlueprint(summary.id);
  const hydratedSummary = await hydrateDlqCount(rest, summary);
  const orderedModuleNames = blueprint.modules.map((module) => module.module);
  const moduleHash = hashModuleNames(orderedModuleNames);

  return {
    summary: hydratedSummary,
    blueprint,
    orderedModuleNames,
    moduleHash,
  };
}

async function hydrateDlqCount(
  rest: MakeRestClient,
  summary: ScenarioSummary,
): Promise<ScenarioSummary> {
  if (summary.dlqCount !== null) {
    return summary;
  }

  if (!summary.isActive) {
    return summary;
  }

  const refreshed = await rest.getScenario(summary.id);

  return {
    ...summary,
    ...refreshed,
    id: summary.id,
    name: refreshed.name || summary.name,
    scheduling: refreshed.scheduling || summary.scheduling,
  };
}

function buildSnapshot(enriched: EnrichedScenario[]): SnapshotScenario[] {
  return enriched.map((scenario) => {
    const notionTargets = [...scenario.blueprint.notionTargets];
    notionTargets.sort(compareNotionTargets);

    return {
      id: scenario.summary.id,
      name: scenario.summary.name,
      isActive: scenario.summary.isActive,
      scheduling: scenario.summary.scheduling,
      trigger: scenario.blueprint.triggerApp,
      notionTargets,
      moduleHash: scenario.moduleHash,
    };
  });
}

function buildState(
  enriched: EnrichedScenario[],
  nowMs: number,
  alerts: Record<string, number> | undefined,
): HealthState {
  const scenarios: Record<string, ScenarioHealthState> = {};

  for (const scenario of enriched) {
    const id = scenario.summary.id;
    const notionWriteTargetCount = scenario.blueprint.notionTargets.filter(
      (target) => isNotionWriteModule(target.module),
    ).length;

    scenarios[id] = {
      isActive: scenario.summary.isActive,
      dlqCount: scenario.summary.dlqCount,
      touchesNotion: scenario.blueprint.touchesNotion,
      notionWriteTargetCount,
      moduleHash: scenario.moduleHash,
    };
  }

  const state: HealthState = {
    updatedMs: nowMs,
    scenarios,
  };

  if (alerts !== undefined && Object.keys(alerts).length > 0) {
    state.alerts = alerts;
  }

  return state;
}

function findRegressions(
  previous: HealthState,
  current: HealthState,
  enriched: EnrichedScenario[],
): Regression[] {
  const regressions: Regression[] = [];
  const names = scenarioNameLookup(enriched);

  for (const [id, after] of Object.entries(current.scenarios)) {
    const before = previous.scenarios[id];

    if (!before) {
      continue;
    }

    if (before.isActive && !after.isActive) {
      regressions.push({
        id,
        name: names[id] ?? "",
        rule: "active-to-inactive",
        before: "isActive=true",
        after: "isActive=false",
      });
    }

    const beforeDlq = before.dlqCount ?? 0;
    if (after.dlqCount !== null && after.dlqCount > beforeDlq) {
      regressions.push({
        id,
        name: names[id] ?? "",
        rule: "dlq-increase",
        before: `dlqCount=${beforeDlq}`,
        after: `dlqCount=${after.dlqCount}`,
      });
    }

    if (notionWriterStopped(before, after)) {
      regressions.push({
        id,
        name: names[id] ?? "",
        rule: "notion-writer-stopped",
        before: formatNotionState(before),
        after: formatNotionState(after),
      });
    }
  }

  return regressions;
}

function notionWriterStopped(
  before: ScenarioHealthState,
  after: ScenarioHealthState,
): boolean {
  const wasWriter = before.isActive && before.notionWriteTargetCount > 0;
  if (!wasWriter) {
    return false;
  }
  const isWriter = after.isActive && after.notionWriteTargetCount > 0;
  return !isWriter;
}

function findStructuralDrifts(
  previous: HealthState | null,
  current: HealthState,
  enriched: EnrichedScenario[],
): StructuralDrift[] {
  if (!previous) {
    return [];
  }

  const drifts: StructuralDrift[] = [];
  const names = scenarioNameLookup(enriched);

  for (const [id, after] of Object.entries(current.scenarios)) {
    const before = previous.scenarios[id];

    if (!before) {
      continue;
    }

    if (before.moduleHash === after.moduleHash) {
      continue;
    }

    drifts.push({
      id,
      name: names[id] ?? "",
      beforeModuleHash: before.moduleHash,
      afterModuleHash: after.moduleHash,
    });
  }

  return drifts;
}

function regressionKey(regression: Regression): string {
  return `${regression.id}:${regression.rule}`;
}

function isRegressionDebounced(
  alerts: Record<string, number>,
  key: string,
  nowMs: number,
): boolean {
  if (FORCE) {
    return false;
  }
  const lastAlertedMs = alerts[key];
  if (lastAlertedMs === undefined) {
    return false;
  }
  return nowMs - lastAlertedMs <= DEBOUNCE_MS;
}

function buildSlackText(regressions: Regression[]): string {
  const lines: string[] = [];
  lines.push(`:warning: *Make scenario health regression(s)* - ${regressions.length} detected`);
  lines.push("");
  for (const regression of regressions) {
    const name = regression.name || "(unnamed scenario)";
    lines.push(
      `* \`${regression.id}\` ${name} - ${regression.rule} - ` +
      `${regression.before} -> ${regression.after}`,
    );
  }
  lines.push("");
  lines.push("Snapshot: `~/biz/reports/automation-catalog/make-latest.json`");
  lines.push("State: `~/biz/var/make-health/last-state.json`");

  return lines.join("\n");
}

async function postSlack(text: string): Promise<void> {
  const cfg = JSON.parse(readFileSync(SLACK_CONFIG, "utf-8"));
  const token = cfg?.slack?.botToken;
  if (!token) throw new Error(`No slack.botToken in ${SLACK_CONFIG}`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error}`);
  } finally {
    clearTimeout(t);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const workerCount = Math.min(limit, items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      const item = items[index];
      nextIndex += 1;
      results[index] = await mapper(item, index);
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());

  await Promise.all(workers);

  return results;
}

function hashModuleNames(moduleNames: string[]): string {
  const orderedModuleNames = moduleNames.join(">");
  const hash = createHash("sha1");
  hash.update(orderedModuleNames);

  return hash.digest("hex").slice(0, 12);
}

function scenarioNameLookup(enriched: EnrichedScenario[]): Record<string, string> {
  const names: Record<string, string> = {};

  for (const scenario of enriched) {
    names[scenario.summary.id] = scenario.summary.name;
  }

  return names;
}

function formatNotionState(state: ScenarioHealthState): string {
  return [
    `isActive=${state.isActive}`,
    `touchesNotion=${state.touchesNotion}`,
    `notionWriteTargetCount=${state.notionWriteTargetCount}`,
  ].join(", ");
}

function compareEnrichedScenarios(
  left: EnrichedScenario,
  right: EnrichedScenario,
): number {
  return compareScenarioIds(left.summary.id, right.summary.id);
}

function compareScenarioIds(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftNumeric = Number.isFinite(leftNumber);
  const rightNumeric = Number.isFinite(rightNumber);

  if (leftNumeric && rightNumeric && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right);
}

function compareNotionTargets(left: NotionTarget, right: NotionTarget): number {
  return left.moduleId.localeCompare(right.moduleId, undefined, { numeric: true });
}

function shadowFixturePath(argv: string[]): string | null {
  const inline = argv.find((arg) => arg.startsWith("--shadow-fixture="));
  if (inline) return inline.slice("--shadow-fixture=".length) || null;
  const index = argv.indexOf("--shadow-fixture");
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertMakeHealthMacLive(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin") return;
  if (env.MAKE_HEALTH_ALLOW_MAC !== "1") {
    throw new Error("macOS live execution requires MAKE_HEALTH_ALLOW_MAC=1");
  }
  if (env.YOUR_COMPANY_RUNTIME_MODE !== "live") {
    throw new Error("macOS live execution requires YOUR_COMPANY_RUNTIME_MODE=live from runtime-manager");
  }
  if (env.YOUR_COMPANY_RUNTIME_LOCK_GROUP !== "make-health") {
    throw new Error("macOS live execution requires runtime-manager lock make-health");
  }

  for (const [name, value] of Object.entries({
    MAKE_HEALTH_STATE_DIR: env.MAKE_HEALTH_STATE_DIR,
    MAKE_HEALTH_LOG_DIR: env.MAKE_HEALTH_LOG_DIR,
    MAKE_HEALTH_SNAPSHOT_PATH: env.MAKE_HEALTH_SNAPSHOT_PATH,
  })) {
    if (!value?.trim() || !isAbsolute(value)) {
      throw new Error(`macOS live execution requires absolute ${name}`);
    }
    if (isWithin(BIZ, value)) {
      throw new Error(`macOS live execution requires ${name} outside the Biz checkout`);
    }
  }
}

function loadMakeHealthShadowFixture(path: string): MakeHealthShadowFixture {
  if (process.env.YOUR_COMPANY_RUNTIME_MODE !== "shadow") {
    throw new Error("make-health shadow replay requires YOUR_COMPANY_RUNTIME_MODE=shadow");
  }
  if (process.env.YOUR_COMPANY_RUNTIME_LOCK_GROUP !== "make-health") {
    throw new Error("make-health shadow replay requires runtime-manager lock make-health");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MakeHealthShadowFixture>;
  if (parsed.schema_version !== 1 || parsed.redacted !== true || parsed.task_id !== "make-health") {
    throw new Error("make-health fixture must be a redacted schema-v1 capture for make-health");
  }
  if (!parsed.captured_at || !parsed.replay || !parsed.expected) {
    throw new Error("make-health shadow fixture is incomplete");
  }
  return parsed as MakeHealthShadowFixture;
}

function runMakeHealthShadow(path: string): number {
  const fixture = loadMakeHealthShadowFixture(path);
  const enriched = Object.entries(fixture.replay.scenario_names).map(([id, name]): EnrichedScenario => ({
    summary: {
      id,
      name,
      isActive: fixture.replay.current.scenarios[id]?.isActive ?? false,
      isPaused: false,
      scheduling: "captured-redacted",
      hookId: null,
      dlqCount: fixture.replay.current.scenarios[id]?.dlqCount ?? null,
      lastEdit: null,
    },
    blueprint: {
      id,
      triggerApp: "captured-redacted",
      modules: [],
      notionModules: [],
      touchesNotion: fixture.replay.current.scenarios[id]?.touchesNotion ?? false,
      notionTargets: [],
    },
    orderedModuleNames: [],
    moduleHash: fixture.replay.current.scenarios[id]?.moduleHash ?? "",
  }));
  const regressions = findRegressions(
    fixture.replay.previous,
    fixture.replay.current,
    enriched,
  );
  const drifts = findStructuralDrifts(
    fixture.replay.previous,
    fixture.replay.current,
    enriched,
  );
  const rules = regressions.map((regression) => regression.rule).sort();
  const expectedRules = [...fixture.expected.regression_rules].sort();
  if (JSON.stringify(rules) !== JSON.stringify(expectedRules)
    || drifts.length !== fixture.expected.structural_drift_count) {
    throw new Error("make-health shadow replay diverged from captured expectations");
  }

  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    mode: "shadow",
    task_id: "make-health",
    fixture_redacted: true,
    replay: { regression_rules: rules, structural_drift_count: drifts.length },
    credential_reads: 0,
    provider_requests: 0,
    network_requests: 0,
    process_spawns: 0,
    state_reads: 0,
    state_writes: 0,
    log_writes: 0,
    slack_writes: 0,
    external_writes: 0,
  })}\n`);
  return 0;
}

function printDryRun(
  snapshotChange: boolean,
  previousState: HealthState | null,
  regressions: Regression[],
  structuralDrifts: StructuralDrift[],
): void {
  process.stdout.write(`${LOG_PREFIX} DRY RUN - no Slack, state, snapshot, or log writes\n`);

  if (!existsSync(SNAPSHOT_PATH)) {
    process.stdout.write(`${LOG_PREFIX} make-latest.json would create\n`);
  } else if (snapshotChange) {
    process.stdout.write(`${LOG_PREFIX} make-latest.json would change\n`);
  } else {
    process.stdout.write(`${LOG_PREFIX} make-latest.json would not change\n`);
  }

  if (!previousState) {
    process.stdout.write(`${LOG_PREFIX} first run - no previous state; no regressions\n`);
    return;
  }

  if (regressions.length === 0) {
    process.stdout.write(`${LOG_PREFIX} no regressions\n`);
  } else {
    process.stdout.write(`${LOG_PREFIX} regressions:\n`);
    for (const regression of regressions) {
      process.stdout.write(
        `${LOG_PREFIX} - ${regression.id} ${regression.name} ` +
        `${regression.rule}: ${regression.before} -> ${regression.after}\n`,
      );
    }
  }

  if (structuralDrifts.length === 0) {
    process.stdout.write(`${LOG_PREFIX} no structural drifts\n`);
    return;
  }

  process.stdout.write(`${LOG_PREFIX} structural drifts:\n`);
  for (const drift of structuralDrifts) {
    process.stdout.write(
      `${LOG_PREFIX} - ${drift.id} ${drift.name} ` +
      `${drift.beforeModuleHash} -> ${drift.afterModuleHash}\n`,
    );
  }
}

async function run(): Promise<number> {
  const now = new Date();
  const nowMs = now.getTime();
  const rest = new MakeRestClient();
  const enriched = await fetchFleet(rest);
  const snapshot = buildSnapshot(enriched);
  const snapshotBytes = JSON.stringify(snapshot, null, 2) + "\n";
  const wouldChange = snapshotWouldChange(snapshotBytes);
  const previousState = readState();

  const previousAlerts: Record<string, number> = {};
  for (const [key, alertedMs] of Object.entries(previousState?.alerts ?? {})) {
    if (nowMs - alertedMs <= DEBOUNCE_MS) {
      previousAlerts[key] = alertedMs;
    }
  }

  const nextState = buildState(enriched, nowMs, previousAlerts);
  const regressions = previousState
    ? findRegressions(previousState, nextState, enriched)
    : [];
  const structuralDrifts = findStructuralDrifts(previousState, nextState, enriched);

  const toAlert = regressions.filter(
    (regression) => !isRegressionDebounced(previousAlerts, regressionKey(regression), nowMs),
  );


  if (DRY_RUN) {
    printDryRun(wouldChange, previousState, regressions, structuralDrifts);

    if (toAlert.length > 0) {
      const text = buildSlackText(toAlert);
      process.stdout.write(`${LOG_PREFIX} would post to the alert channel:\n${text}\n`);
    }

    return 0;
  }

  let event: DecisionEvent;

  if (!previousState) {
    event = "first-run";
  } else if (regressions.length === 0) {
    event = "no-regressions";
  } else if (toAlert.length > 0) {
    const text = buildSlackText(toAlert);

    try {
      await postSlack(text);
    } catch (err) {
      const message = (err as Error).message;
      logDecision({
        event: "error",
        phase: "slack-post",
        error: message,
        regressions: toAlert,
      });
      process.stderr.write(`${LOG_PREFIX} Slack alert failed: ${message}\n`);

      return 1;
    }

    const nextAlerts: Record<string, number> = { ...previousAlerts };
    for (const regression of toAlert) {
      nextAlerts[regressionKey(regression)] = nowMs;
    }
    nextState.alerts = nextAlerts;
    event = "alerted";
  } else {
    event = "debounced";
  }

  const snapshotChanged = writeIfChanged(SNAPSHOT_PATH, snapshotBytes);
  writeState(nextState);
  logDecision({
    event,
    scenarioCount: enriched.length,
    snapshotChanged,
    regressions: toAlert,
    debouncedCount: regressions.length - toAlert.length,
    structuralDrifts,
  });

  process.stdout.write(
    `${LOG_PREFIX} make-latest.json ${snapshotChanged ? "changed" : "unchanged"}\n`,
  );
  process.stdout.write(`${LOG_PREFIX} event=${event}; regressions=${regressions.length}; alerting=${toAlert.length}\n`);

  return 0;
}

async function main(): Promise<number> {
  if (SHADOW_FIXTURE) {
    try {
      return runMakeHealthShadow(SHADOW_FIXTURE);
    } catch (err) {
      process.stderr.write(`${LOG_PREFIX} shadow error: ${(err as Error).message}\n`);
      return 1;
    }
  }

  try {
    assertMakeHealthMacLive();
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX} ${(err as Error).message}\n`);
    return 6;
  }

  try {
    return await run();
  } catch (err) {
    const message = (err as Error).message;

    if (!DRY_RUN) {
      logDecision({
        event: "error",
        error: message,
      });
    }

    process.stderr.write(`${LOG_PREFIX} error: ${message}\n`);

    return 1;
  }
}

const isCliEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntrypoint) {
  main().then(code => process.exit(code));
}
