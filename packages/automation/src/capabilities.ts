/**
 * 官方入口能力探测（供 GET /api/v1/meta 与前端"能力开关"展示）。
 *
 * 探测失败不抛异常：返回 available=false + error，由后端决定展示"官方入口不可用"。
 */

import { runProcess, type ProcessRunResult } from './process/process-tree.ts';
import { EXPECTED_PLAYWRIGHT_VERSION, parsePlaywrightVersion, resolvePlaywrightCli } from './playwrightCli.ts';
import { MCP_DEFAULT_ALLOWED_TOOLS, MCP_DEFAULT_CAPS } from './mcp/whitelist.ts';
import { listAgentLoops, type AgentLoop } from './agents/scaffold.ts';
import { describeCliCommands } from './cli/whitelist.ts';
import { MCP_PROTOCOL_VERSION } from './mcp/client.ts';

export interface AutomationCapabilities {
  playwright: {
    available: boolean;
    cliPath: string | null;
    version: string | null;
    expectedVersion: string;
    error?: string;
  };
  mcp: {
    available: boolean;
    defaultCaps: string[];
    allowedTools: string[];
    protocolVersion: string;
    transports: ['stdio'];
  };
  cli: {
    available: boolean;
    allowedCommands: string[];
    needsConfirm: string[];
    denied: string[];
    unsafeEnabled: boolean;
  };
  agents: {
    available: boolean;
    loops: { loop: AgentLoop; description: string }[];
    prompts: true;
  };
  unsafeToolsEnabled: boolean;
}

export interface DetectCapabilitiesOptions {
  playwrightCliPath?: string;
  unsafeToolsEnabled?: boolean;
}

function pickVersion(result: ProcessRunResult): string | null {
  const raw = `${result.stdout}\n${result.stderr}`;
  return parsePlaywrightVersion(raw);
}

export async function detectAutomationCapabilities(
  options: DetectCapabilitiesOptions = {},
): Promise<AutomationCapabilities> {
  const unsafeToolsEnabled =
    options.unsafeToolsEnabled ?? process.env['PW_ENABLE_UNSAFE_TOOLS'] === '1';
  let cliPath: string | null = null;
  let version: string | null = null;
  let error: string | undefined;
  try {
    cliPath = resolvePlaywrightCli(options.playwrightCliPath);
    const result = await runProcess(process.execPath, [cliPath, '--version'], {
      timeoutMs: 15_000,
      maxBufferBytes: 64 * 1024,
      label: 'playwright-version',
    });
    if (result.spawnError !== null) {
      error = result.spawnError;
    } else if (result.exitCode !== 0) {
      error = `官方 CLI --version 退出码 ${String(result.exitCode)}`;
    } else {
      version = pickVersion(result);
      if (version === null) error = '无法解析官方 CLI --version 输出';
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const available = cliPath !== null && version !== null;
  const cliCommands = describeCliCommands();

  return {
    playwright: {
      available,
      cliPath,
      version,
      expectedVersion: EXPECTED_PLAYWRIGHT_VERSION,
      ...(error === undefined ? {} : { error }),
    },
    mcp: {
      available,
      defaultCaps: [...MCP_DEFAULT_CAPS],
      allowedTools: [...MCP_DEFAULT_ALLOWED_TOOLS],
      protocolVersion: MCP_PROTOCOL_VERSION,
      transports: ['stdio'],
    },
    cli: {
      available,
      allowedCommands: cliCommands.allow,
      needsConfirm: cliCommands.needsConfirm,
      denied: cliCommands.deny,
      unsafeEnabled: unsafeToolsEnabled,
    },
    agents: {
      available,
      loops: listAgentLoops(),
      prompts: true,
    },
    unsafeToolsEnabled,
  };
}