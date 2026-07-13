import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PermissionMode =
  | "default"
  | "plan"
  | "accetEdits"
  | "bypassPermissions"
  | "dontAsk";

export interface PermissionDecision {
  action: "allow" | "deny" | "confirm";
  message?: string;
}

// ------- Layer 2: built-in dangerous-command detection  -------
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s/,
  /\bgit\s+(push|reset|clean|checkout\s+\.)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s/,
  />\s*\/dev\//,
  /\bkill\b/,
  /\bpkill\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  // Windows dangerous commands (case-insensitive: Windows command names
  // aren't case-sensitive)
  /\bdel\s/i,
  /\brmdir\s/i,
  /\bformat\s/i,
  /\btaskkill\s/i,
  /\bRemove-Item\s/i,
  /\bStop-Process\s/i,
];

// ------- Layer 1: declarative allow/deny rules  -------
interface ParsedRule {
  tool: string;
  pattern: string | null;
}

interface PermissionRules {
  allow: ParsedRule[];
  deny: ParsedRule[];
}

function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([a-z_]+)\((.+)\)$/);
  if (match) {
    return { tool: match[1], pattern: match[2] };
  }

  return { tool: rule, pattern: null};
}

function loadSettings(filePath: string): any {
  if(!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

let cachedRules: PermissionRules | null = null;
export function loadPermissionRules(): PermissionRules {
  if (cachedRules) return cachedRules;

  const allow: ParsedRule[] = [];
  const deny: ParsedRule[] = [];

  const userSettings = loadSettings(join(homedir(), ".claude", "settings.json"));
  const projectSettings = loadSettings(join(process.cwd(), ".claude", "settings.json"));

  for (const settings of [userSettings, projectSettings]) {
    if(!settings?.permissions) continue;
    if(Array.isArray(settings.permissions.allow)){
      for (const r of settings.permissions.allow) allow.push(parseRule(r));
    }
    if (Array.isArray(settings.permissions.deny)){
      for (const r of settings.permissions.deny) deny.push(parseRule(r));
    }
  }

  cachedRules = { allow, deny };
  return cachedRules;
}

export function resetPermissionRuleCache(): void { cachedRules = null; }

function matchesRule(
  rule: ParsedRule,
  toolName: string,
  input: Record<string, unknown>
): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pattern) return true;

  let value = "";
  if (toolName === "run_shell") value = String(input.command ?? "");
  else if (typeof input.file_path ==="string") value = input.file_path;
  else return true;

  const pattern = rule.pattern;
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }

  return value === pattern;
}

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

function checkPermissionRules(
  toolName: string,
  input: Record<string, unknown>
): "allow" | "deny" | null {
  const rules = loadPermissionRules();

  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, input)) return "deny";
  }
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, input)) return "allow";
  }

  return null;
}

export function checkPermission(
  toolName: string,
  input: Record<string, unknown>,
  isReadOnly: boolean,
  mode: PermissionMode = "default"
): PermissionDecision {
  if (mode === "bypassPermissions") return { action: "allow" };


  // ------- Layer 1: Declarative Rules  -------
  const ruleResult = checkPermissionRules(toolName, input);
  if (ruleResult === "deny") {
    return { action: "deny", message: `Denied by permission rule for ${toolName}` };
  }
  if (ruleResult === "allow" && mode !== "plan") {
    return { action: "allow" };
  }

  if (isReadOnly) return { action: "allow" };

  if (mode === "plan") {
    return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
  }

  if (mode === "accetEdits" && toolName === "edit_file") {
    return { action: "allow" };
  }

  // Layer 2: built-in dangerous-command detection.
  if (toolName === "run_shell" && isDangerous(String(input.command ?? ""))) {
    const command = String(input.command ?? "");
    if (mode === "dontAsk") {
      return { action: "deny", message: `Auto-denied (dontAsk mode): ${command}` };
    }
    return { action: "confirm", message: command };
  }

  return { action: "allow" };
}


// npx tsx -e "
// import('./src/permissions.js').then((m) => {
//   console.log('isDangerous(rm -rf /tmp/x):', m.isDangerous('rm -rf /tmp/x'));
//   console.log('isDangerous(npm test):', m.isDangerous('npm test'));
//   console.log('default + dangerous:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'default'));
//   console.log('dontAsk + dangerous:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'dontAsk'));
//   console.log('bypassPermissions + dangerous:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'bypassPermissions'));
// });
// "
