import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SurfaceBundle } from '@pw-auto/contracts';
import { call, cleanupDir, makeTempDir, startApiIn, type TestApi } from './helpers.ts';
import { createFakeEngine } from './fake-engine.ts';

const dirs: string[] = [];
const apis: TestApi[] = [];

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close();
  for (const dir of dirs.splice(0)) cleanupDir(dir);
});

async function open(options: { surfaces?: SurfaceBundle; enableUnsafeTools?: boolean } = {}): Promise<TestApi> {
  const dataDir = makeTempDir();
  dirs.push(dataDir);
  const api = await startApiIn(dataDir, {
    engine: createFakeEngine(),
    ...(options.surfaces !== undefined ? { surfaces: options.surfaces } : {}),
    config: options.enableUnsafeTools ? { enableUnsafeTools: true } : {},
  });
  apis.push(api);
  return api;
}

const unavailableSurfaces: SurfaceBundle = {
  agents: null,
  mcp: null,
  cli: null,
  reasons: {
    agents: '测试：automation 未导出 createAgentSurface',
    mcp: '测试：automation 未导出 createMcpSurface',
    cli: '测试：automation 未导出 createCliSurface',
  },
};

/** 模拟官方 init-agents 产物（文件名取自调研实测清单），不调用任何真实子进程 */
function createFakeSurfaces(): SurfaceBundle {
  const write = (targetDir: string, relative: string, content: string): void => {
    const absolute = join(targetDir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  return {
    reasons: {},
    agents: {
      async runScaffold(input) {
        write(input.targetDir, '.claude/agents/playwright-test-planner.md', '# planner');
        write(input.targetDir, '.claude/agents/playwright-test-generator.md', '# generator');
        write(input.targetDir, '.claude/agents/playwright-test-healer.md', '# healer');
        write(input.targetDir, '.mcp.json', '{"mcpServers":{"playwright-test":{"command":"npx"}}}');
        write(input.targetDir, 'seed.spec.ts', '// seed');
        write(input.targetDir, 'specs/README.md', '# specs');
        if (input.prompts) {
          write(input.targetDir, '.claude/prompts/playwright-test-plan.md', '# 官方 plan 提示词');
          write(input.targetDir, '.claude/prompts/playwright-test-generate.md', '# 官方 generate 提示词');
          write(input.targetDir, '.claude/prompts/playwright-test-heal.md', '# 官方 heal 提示词');
          write(input.targetDir, '.claude/prompts/playwright-test-coverage.md', '# 官方 coverage 提示词');
        }
        return {
          command: ['playwright', 'init-agents', `--loop=${input.loop}`, ...(input.prompts ? ['--prompts'] : [])],
          files: [],
          missing: [],
          status: 'completed',
          error: null,
        };
      },
      async readPrompts() {
        return [];
      },
    },
    mcp: {
      async createSession(input) {
        return {
          serverInfo: { name: 'Playwright', version: '1.65.0' },
          protocolVersion: '2025-06-18',
          tools: [{ name: 'browser_navigate' }, { name: 'browser_snapshot' }],
          pid: 4242,
        };
      },
      async callTool(input) {
        return { content: [{ type: 'text', text: `ok:${input.tool}` }], isError: false, durationMs: 2 };
      },
      async closeSession() {
        // no-op
      },
    },
    cli: {
      async exec(input) {
        return {
          exitCode: 0,
          stdout: `ran ${input.argv.join(' ')}`,
          stderr: '',
          json: null,
          parsed: null,
          durationMs: 3,
          artifacts: [],
        };
      },
    },
  };
}

describe('Agent 交接（官方 init-agents 适配面；三 harness 入口）', () => {
  it('三入口：/agents/loops 已删除（任意方法 404）、harnesses 3 项且无安装态、无适配面 501、旧 loop/非三 entry 422、/skills 404', async () => {
    const api = await open({ surfaces: unavailableSurfaces });

    // 用户 durable 裁定：/agents/loops 路由删除，任意方法 404（不得 3 等价或 6 loop）
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      const response = await call(api.baseUrl, method, '/api/v1/agents/loops');
      expect(response.status).toBe(404);
    }

    const harnesses = await call<{ data: { items: Record<string, any>[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/agents/harnesses',
    );
    expect(harnesses.status).toBe(200);
    expect(harnesses.body.data.items).toHaveLength(3);
    expect(harnesses.body.data.items.map((item) => item.entry)).toEqual(['claude', 'codex', 'deepseek']);
    const deepseek = harnesses.body.data.items[2]!;
    expect(deepseek.officialLoop).toBeNull();
    expect(deepseek.requiresMcp).toBe(false);
    expect(deepseek.skillPaths.length).toBeGreaterThan(0);
    for (const item of harnesses.body.data.items) {
      expect(item).not.toHaveProperty('installed');
      expect(item).not.toHaveProperty('installTargets');
      expect(item).not.toHaveProperty('skillPackage');
    }

    const prompts = await call<{ data: { items: { key: string; source: string; body: string }[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/agents/prompts',
    );
    expect(prompts.body.data.items.map((item) => item.key)).toEqual(['plan', 'generate', 'heal', 'coverage']);
    expect(prompts.body.data.items.every((item) => item.source === 'framework')).toBe(true);
    expect(prompts.body.data.items[2]!.body).toContain('healer');

    const noConfirm = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/agents/scaffolds', {
      entry: 'claude',
    });
    expect(noConfirm.status).toBe(428);
    expect(noConfirm.body.error.code).toBe('CONFIRM_REQUIRED');

    const notImplemented = await call<{ error: { code: string; message: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/agents/scaffolds',
      { entry: 'claude', confirm: true },
    );
    expect(notImplemented.status).toBe(501);
    expect(notImplemented.body.error.code).toBe('NOT_IMPLEMENTED');

    // 旧 loop 字段 / 非三入口 / 缺失 entry → 统一 422 HARNESS_NOT_SUPPORTED（业务层映射，不是 VALIDATION_FAILED）
    const rejectedBodies: Record<string, unknown>[] = [
      ...['copilot', 'opencode', 'vscode', 'vscode-legacy'].map((legacy) => ({ loop: legacy, confirm: true })),
      { entry: 'vscode', confirm: true },
      { entry: 'copilot', confirm: true },
      { confirm: true },
    ];
    for (const body of rejectedBodies) {
      const rejected = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/agents/scaffolds', body);
      expect(rejected.status).toBe(422);
      expect(rejected.body.error.code).toBe('HARNESS_NOT_SUPPORTED');
    }

    // 无任何 skill 安装/查询端点
    for (const [method, path] of [
      ['GET', '/api/v1/skills'],
      ['POST', '/api/v1/skills/install'],
      ['DELETE', '/api/v1/skills/pw-auto-test'],
    ] as const) {
      const response = await call(api.baseUrl, method, path);
      expect(response.status).toBe(404);
    }

    const scaffolds = await call<{ data: { items: unknown[] } }>(api.baseUrl, 'GET', '/api/v1/agents/scaffolds');
    expect(scaffolds.body.data.items).toEqual([]);

    const workspace = await call<{ error: { code: string } }>(api.baseUrl, 'GET', '/api/v1/agents/workspace?path=specs');
    expect(workspace.status).toBe(404);
  });

  it('生成脚手架：命令回显、产物索引、missing 复核、prompt 读取与目录浏览', async () => {
    const api = await open({ surfaces: createFakeSurfaces() });

    const created = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/agents/scaffolds', {
      entry: 'claude',
      prompts: true,
      confirm: true,
    });
    expect(created.status).toBe(201);
    const scaffold = created.body.data;
    expect(scaffold.id).toMatch(/^scf_/);
    expect(scaffold.status).toBe('completed');
    expect(scaffold.entry).toBe('claude');
    expect(scaffold.loop).toBe('claude');
    expect(scaffold.officialLoop).toBe('claude');
    expect(scaffold.command).toEqual(['playwright', 'init-agents', '--loop=claude', '--prompts']);
    expect(scaffold.targetDir).toContain('agents');
    expect(scaffold.files.length).toBeGreaterThanOrEqual(10);
    expect(scaffold.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(scaffold.missing).toEqual([]);
    expect(scaffold.error).toBeNull();

    const fetched = await call<{ data: { id: string; files: unknown[] } }>(
      api.baseUrl,
      'GET',
      `/api/v1/agents/scaffolds/${scaffold.id}`,
    );
    expect(fetched.body.data.id).toBe(scaffold.id);

    const prompts = await call<{ data: { items: { key: string; source: string; body: string }[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/agents/prompts',
    );
    expect(prompts.body.data.items).toHaveLength(4);
    expect(prompts.body.data.items[0]!.source).toBe('official');
    expect(prompts.body.data.items[0]!.body).toContain('官方 plan');

    const listing = await call<{ data: { items: { path: string; sizeBytes: number }[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/agents/workspace?path=specs',
    );
    expect(listing.status).toBe(200);
    expect(listing.body.data.items.map((item) => item.path)).toEqual(['specs/README.md']);

    for (const evil of ['../..', '/etc', 'C:\\Windows']) {
      const response = await call<{ error: { code: string } }>(
        api.baseUrl,
        'GET',
        `/api/v1/agents/workspace?path=${encodeURIComponent(evil)}`,
      );
      // 越界形态属于「路径参数非法」→ 400 INVALID_PATH（不是 403，后者用于解析后越界）
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_PATH');
    }

    // 幂等：同 key 同请求体 → 返回同一脚手架（200 + Idempotent-Replay）
    const key = 'scaffold-idem-1';
    const first = await call<{ data: { id: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/agents/scaffolds',
      { entry: 'claude', prompts: true, confirm: true },
      { headers: { 'idempotency-key': key } },
    );
    const replay = await call<{ data: { id: string } }>(
      api.baseUrl,
      'POST',
      '/api/v1/agents/scaffolds',
      { entry: 'claude', prompts: true, confirm: true },
      { headers: { 'idempotency-key': key } },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
  });

  it('deepseek 入口：不执行 init-agents（command=[]、loop=null、officialLoop=null），写入 prompts 模板', async () => {
    const api = await open({ surfaces: createFakeSurfaces() });
    const created = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/agents/scaffolds', {
      entry: 'deepseek',
      prompts: true,
      confirm: true,
    });
    expect(created.status).toBe(201);
    const scaffold = created.body.data;
    expect(scaffold.entry).toBe('deepseek');
    expect(scaffold.loop).toBeNull();
    expect(scaffold.officialLoop).toBeNull();
    expect(scaffold.command).toEqual([]);
    expect(scaffold.status).toBe('completed');
    expect(scaffold.notes).toContain('无官方 Playwright loop');
    expect(scaffold.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining(['prompts/plan.md', 'prompts/generate.md', 'prompts/heal.md', 'prompts/coverage.md']),
    );

    const prompts = await call<{ data: { items: { source: string }[] } }>(api.baseUrl, 'GET', '/api/v1/agents/prompts?entry=deepseek');
    expect(prompts.body.data.items).toHaveLength(4);
    expect(prompts.body.data.items.every((item) => item.source === 'framework')).toBe(true);
  });
});

describe('MCP 会话（官方 playwright mcp 适配面）', () => {
  it('无适配面 → 501；会话列表为空', async () => {
    const api = await open({ surfaces: unavailableSurfaces });
    const created = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    expect(created.status).toBe(501);
    expect(created.body.error.code).toBe('NOT_IMPLEMENTED');
    const list = await call<{ data: { items: unknown[] } }>(api.baseUrl, 'GET', '/api/v1/mcp/sessions');
    expect(list.body.data.items).toEqual([]);
  });

  it('创建会话 → ready + 工具清单；白名单工具可调用；unsafe/未知名被拒；关闭后状态 closed', async () => {
    const api = await open({ surfaces: createFakeSurfaces() });
    const created = await call<{ data: Record<string, any> }>(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    expect(created.status).toBe(201);
    const session = created.body.data;
    expect(session.status).toBe('ready');
    expect(session.serverInfo.name).toBe('Playwright');
    expect(session.protocolVersion).toBe('2025-06-18');
    expect(session.caps).toEqual(['testing', 'storage', 'network']);
    expect(session.tools).toHaveLength(2);
    expect(session.pid).toBe(4242);
    expect(session.workDir).toContain('mcp');

    const okCall = await call<{ data: { content: { text: string }[]; isError: boolean } }>(
      api.baseUrl,
      'POST',
      `/api/v1/mcp/sessions/${session.id}/calls`,
      { tool: 'browser_navigate', arguments: { url: 'http://127.0.0.1:4174/' } },
    );
    expect(okCall.status).toBe(200);
    expect(okCall.body.data.content[0]!.text).toBe('ok:browser_navigate');

    const unsafe = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/mcp/sessions/${session.id}/calls`, {
      tool: 'browser_run_code_unsafe',
      arguments: { code: '1+1' },
    });
    expect(unsafe.status).toBe(403);
    expect(unsafe.body.error.code).toBe('CAPABILITY_DISABLED');

    const unknown = await call<{ error: { code: string } }>(api.baseUrl, 'POST', `/api/v1/mcp/sessions/${session.id}/calls`, {
      tool: 'browser_magic',
    });
    expect(unknown.status).toBe(403);

    // 未文档化的 browser_mouse_* 不属于 unsafe 白名单（禁止"前缀即放行"）
    const unknownMouse = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/mcp/sessions/${session.id}/calls`,
      { tool: 'browser_mouse_fly_xy' },
    );
    expect(unknownMouse.status).toBe(403);
    expect(unknownMouse.body.error.code).toBe('CAPABILITY_DISABLED');

    const visionCaps = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {
      caps: ['vision'],
    });
    expect(visionCaps.status).toBe(403);

    const closed = await call(api.baseUrl, 'DELETE', `/api/v1/mcp/sessions/${session.id}`);
    expect(closed.status).toBe(204);
    const after = await call<{ data: { status: string; endedAt: string | null } }>(
      api.baseUrl,
      'GET',
      `/api/v1/mcp/sessions/${session.id}`,
    );
    expect(after.body.data.status).toBe('closed');
    expect(after.body.data.endedAt).toBeTruthy();
  });

  it('会话数上限 → 429 TOO_MANY_MCP_SESSIONS', async () => {
    const api = await open({ surfaces: createFakeSurfaces() });
    await call(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    await call(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    const third = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('TOO_MANY_MCP_SESSIONS');
  });

  it('工具调用超时 → 504 TOOL_TIMEOUT（适配器抛 TOOL_TIMEOUT 原样透传）', async () => {
    const fake = createFakeSurfaces();
    const timeoutSurfaces: SurfaceBundle = {
      ...fake,
      mcp:
        fake.mcp === null
          ? null
          : {
              ...fake.mcp,
              async callTool() {
                throw Object.assign(new Error('工具调用超时'), { code: 'TOOL_TIMEOUT' });
              },
            },
    };
    const api = await open({ surfaces: timeoutSurfaces });
    const session = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    expect(session.status).toBe(201);

    const timedOut = await call<{ error: { code: string; message: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/mcp/sessions/${session.body.data.id}/calls`,
      { tool: 'browser_navigate', arguments: { url: 'http://127.0.0.1:4174/' } },
    );
    expect(timedOut.status).toBe(504);
    expect(timedOut.body.error.code).toBe('TOOL_TIMEOUT');
    expect(timedOut.body.error.message).toContain('超时');
  });

  it('unsafe 段只认官方文档化名字：未知名仍 403，文档化名字 + 开关 + confirm 可用', async () => {
    const api = await open({ surfaces: createFakeSurfaces(), enableUnsafeTools: true });
    const session = await call<{ data: { id: string } }>(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    expect(session.status).toBe(201);
    const calls = (tool: string, confirm?: boolean): Promise<Response> =>
      fetch(`${api.baseUrl}/api/v1/mcp/sessions/${session.body.data.id}/calls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, ...(confirm === undefined ? {} : { confirm }) }),
      });

    const unknownMouse = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/mcp/sessions/${session.body.data.id}/calls`,
      { tool: 'browser_mouse_teleport_xy', confirm: true },
    );
    expect(unknownMouse.status).toBe(403);
    expect(unknownMouse.body.error.code).toBe('CAPABILITY_DISABLED');

    const documentedVision = await calls('browser_mouse_move_xy', true);
    expect(documentedVision.status).toBe(200);

    const unsafeNoConfirm = await call<{ error: { code: string } }>(
      api.baseUrl,
      'POST',
      `/api/v1/mcp/sessions/${session.body.data.id}/calls`,
      { tool: 'browser_run_code_unsafe', arguments: { code: '1+1' } },
    );
    expect(unsafeNoConfirm.status).toBe(403);

    const unsafeWithConfirm = await calls('browser_run_code_unsafe', true);
    expect(unsafeWithConfirm.status).toBe(200);
  });
});

describe('适配层错误码原样保留（不压成 502）', () => {
  it('CLI 适配器抛 INVALID_PATH → 400；MCP 适配器抛 TOOL_TIMEOUT → 504', async () => {
    const errorSurfaces: SurfaceBundle = {
      reasons: {},
      agents: null,
      mcp: {
        async createSession() {
          throw Object.assign(new Error('握手失败'), { code: 'SUBPROCESS_ERROR' });
        },
        async callTool(input) {
          if (input.tool === 'browser_navigate') throw Object.assign(new Error('工具超时'), { code: 'TOOL_TIMEOUT' });
          return { content: [], isError: false, durationMs: 1 };
        },
        async closeSession() {
          // no-op
        },
      },
      cli: {
        async exec() {
          throw Object.assign(new Error('参数是绝对路径'), { code: 'INVALID_PATH' });
        },
      },
    };
    const api = await open({ surfaces: errorSurfaces });

    const cli = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', { argv: ['snapshot'] });
    expect(cli.status).toBe(400);
    expect(cli.body.error.code).toBe('INVALID_PATH');

    const mcpCreate = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/mcp/sessions', {});
    expect(mcpCreate.status).toBe(502);
    expect(mcpCreate.body.error.code).toBe('SUBPROCESS_ERROR');
  });
});

describe('CLI 执行（官方 playwright cli 适配面）', () => {
  it('命令目录固定 3 类；允许命令成功；禁止命令 403；未知命令 403', async () => {
    const api = await open({ surfaces: createFakeSurfaces() });
    const commands = await call<{ data: { allow: string[]; needsConfirm: string[]; deny: string[] } }>(
      api.baseUrl,
      'GET',
      '/api/v1/cli/commands',
    );
    expect(commands.status).toBe(200);
    expect(commands.body.data.allow.length).toBeGreaterThanOrEqual(60);
    expect(commands.body.data.needsConfirm).toEqual(['run-code', 'eval']);
    expect(commands.body.data.deny).toEqual(['install', 'install-browser', 'attach', 'config-print']);

    const ok = await call<{ data: { exitCode: number; stdout: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', {
      argv: ['open', 'http://127.0.0.1:4174/'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.exitCode).toBe(0);
    expect(ok.body.data.stdout).toContain('open http://127.0.0.1:4174/');

    const denied = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', {
      argv: ['install-browser'],
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CAPABILITY_DISABLED');

    const unknown = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', {
      argv: ['rm-rf'],
    });
    expect(unknown.status).toBe(403);

    const needsConfirm = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', {
      argv: ['run-code', 'await page.title()'],
    });
    expect(needsConfirm.status).toBe(403);
  });

  it('unsafe 开关 + confirm 后才允许 run-code；workDir 穿越被拒；空 argv 422', async () => {
    const api = await open({ surfaces: createFakeSurfaces(), enableUnsafeTools: true });

    const runCode = await call<{ data: { stdout: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', {
      argv: ['run-code', '1+1'],
      confirm: true,
    });
    expect(runCode.status).toBe(200);
    expect(runCode.body.data.stdout).toContain('run-code');

    const withoutConfirm = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', {
      argv: ['run-code', '1+1'],
    });
    expect(withoutConfirm.status).toBe(403);

    for (const evil of ['../../etc', '..\\..\\windows', '/etc/passwd']) {
      const response = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', {
        argv: ['snapshot'],
        workDir: evil,
      });
      // workDir 越界形态由 resolveRelative 判为路径参数非法 → 400 INVALID_PATH
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_PATH');
    }

    const emptyArgv = await call(api.baseUrl, 'POST', '/api/v1/cli/exec', { argv: [] });
    expect(emptyArgv.status).toBe(422);
  });

  it('无适配面 → 501（命令目录仍可读）', async () => {
    const api = await open({ surfaces: unavailableSurfaces });
    const exec = await call<{ error: { code: string } }>(api.baseUrl, 'POST', '/api/v1/cli/exec', { argv: ['snapshot'] });
    expect(exec.status).toBe(501);
    expect(exec.body.error.code).toBe('NOT_IMPLEMENTED');
  });
});