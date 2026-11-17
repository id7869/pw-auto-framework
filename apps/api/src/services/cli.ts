/**
 * CLI 执行服务（官方 `playwright cli` 子进程由 automation 适配面托管）。
 * 契约：docs/api-contract.md §9。
 *
 * 纪律：argv 逐项透传（禁止命令字符串拼接）；argv[0] 白名单；安装/连接真实浏览器类命令禁止；
 * run-code / eval 需 PW_ENABLE_UNSAFE_TOOLS=1 + confirm。
 */

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  CLI_ALLOW_COMMANDS,
  CLI_DENY_COMMANDS,
  CLI_NEEDS_CONFIRM_COMMANDS,
  classifyCliCommand,
  type CliCommandsResponse,
  type CliExecRequest,
  type CliExecResponse,
  type SurfaceBundle,
} from '@pw-auto/contracts';
import { AppError, fromAdapterError } from '../errors.ts';
import { assertWithinRoot, ensureDir, resolveRelative } from '../paths.ts';
import { writeAudit } from '../repositories/audit.ts';

export interface CliServiceDeps {
  db: DatabaseSync;
  surfaces: SurfaceBundle;
  dataDir: string;
  enableUnsafeTools: boolean;
  log: (message: string) => void;
}

export class CliService {
  private readonly db: DatabaseSync;
  private readonly surfaces: SurfaceBundle;
  private readonly dataDir: string;
  private readonly enableUnsafeTools: boolean;
  private readonly log: (message: string) => void;
  private readonly cliRoot: string;
  private readonly defaultWorkDir: string;

  constructor(deps: CliServiceDeps) {
    this.db = deps.db;
    this.surfaces = deps.surfaces;
    this.dataDir = deps.dataDir;
    this.enableUnsafeTools = deps.enableUnsafeTools;
    this.log = deps.log;
    this.cliRoot = ensureDir(join(this.dataDir, 'cli'));
    this.defaultWorkDir = this.cliRoot;
  }

  commands(): CliCommandsResponse {
    return {
      allow: [...CLI_ALLOW_COMMANDS],
      needsConfirm: [...CLI_NEEDS_CONFIRM_COMMANDS],
      deny: [...CLI_DENY_COMMANDS],
    };
  }

  async exec(input: CliExecRequest, actor: string): Promise<CliExecResponse> {
    const surface = this.surfaces.cli;
    if (!surface) {
      throw new AppError('NOT_IMPLEMENTED', this.surfaces.reasons['cli'] ?? '官方 playwright cli 适配不可用');
    }

    const command = input.argv[0] ?? '';
    const role = classifyCliCommand(command);
    if (role === 'deny') {
      throw new AppError('CAPABILITY_DISABLED', `命令被禁止：${command}（安装类/连接本机真实浏览器类命令不允许通过 API 执行）`);
    }
    if (role === 'unknown') {
      throw new AppError('CAPABILITY_DISABLED', `命令不在白名单内：${command}`);
    }
    if (role === 'needsConfirm' && (!this.enableUnsafeTools || input.confirm !== true)) {
      throw new AppError(
        'CAPABILITY_DISABLED',
        `命令 ${command} 等价任意代码执行：需 PW_ENABLE_UNSAFE_TOOLS=1 且请求体 confirm:true`,
      );
    }

    const workDir =
      input.workDir === undefined
        ? this.defaultWorkDir
        : resolveRelative(this.cliRoot, input.workDir, 'CLI 工作目录越界');
    assertWithinRoot(this.dataDir, workDir, 'CLI 工作目录越出数据目录');

    try {
      const result = await surface.exec({
        argv: input.argv,
        ...(input.session !== undefined ? { session: input.session } : {}),
        workDir,
        timeoutMs: input.timeoutMs,
        allowUnsafe: this.enableUnsafeTools && input.confirm === true,
      });
      writeAudit(this.db, { actor, action: 'cli.exec', target: command, detail: { argv: input.argv.slice(0, 8) } });
      return result;
    } catch (error) {
      this.log(`[cli] 官方 CLI 执行失败：${error instanceof Error ? error.message : String(error)}`);
      throw fromAdapterError(error, '官方 playwright cli 执行失败');
    }
  }
}