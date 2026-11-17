/**
 * A14 NL API 闭环与门禁（R6；N1/N2/N4）。
 *
 * 覆盖：
 *  - 创建带 nl.text 用例 → GET/PUT/DELETE nl（draft/sourceHash/lines/kind）；
 *  - 生成任务：queued → running → ready（claim/submit）→ accepted；冲突 409、rule 403、submit 非法 422；
 *  - accept 是唯一写 steps 的路径；validate 200；run passed；items/产物；spec 预览只读；
 *  - stale：PUT 后 validate 200 + NL_STALE、run 409 NL_STALE、allowStaleNl 放行、accept 409（force 可强制）；
 *  - 多步骤业务语义（6 行 6 步，含 select/click/expectText）；ambiguous warning 不生成猜测步骤；reject/cancel；
 *  - 5 态：draft → generating → generated → stale → invalid（A14-3：租约过期 → 请求级回收 → failed）。
 */

import { test, expect } from '@playwright/test';
import {
  acceptNlGeneration,
  cancelNlGeneration,
  claimNlGeneration,
  createCase,
  createNlGeneration,
  deleteNl,
  errorCodeOf,
  getNl,
  getNlGeneration,
  getSpecPreview,
  listNlQueue,
  listNlGenerationsForCase,
  listRunArtifacts,
  listRunItems,
  putNl,
  rejectNlGeneration,
  startRun,
  submitNlGeneration,
  unwrap,
  validateCase,
  waitRun,
} from '../support/api.ts';
import { saveJson } from '../support/evidence.ts';
import { FIXTURE_BASE } from '../support/env.ts';
import {
  accept,
  completeQueuedGeneration,
  createGeneration,
  generate,
  generationItems,
  readCase,
  readNl,
} from '../support/nl-agent.ts';
import type { NlGeneration, NlSource } from '../support/types.ts';

const SCENARIO = 'a14-nl-api';

const SIMPLE_NL = [`打开 ${FIXTURE_BASE}/`, '页面上应该看到标题「演示站」', '页面上应该出现文本「你好，自动化」'].join('\n');

const SIMPLE_STEPS = [
  { id: 's1', action: 'goto' as const, url: `${FIXTURE_BASE}/`, label: '打开演示站' },
  { id: 's2', action: 'expectVisible' as const, target: { by: 'role' as const, role: 'heading', name: '演示站' }, label: '标题可见' },
  { id: 's3', action: 'expectText' as const, target: { by: 'testId' as const, testId: 'hello' }, value: '你好，自动化', label: '问候语' },
];

const SIMPLE_ORIGIN = { s1: { nlLine: 1 }, s2: { nlLine: 2 }, s3: { nlLine: 3 } };

const LOGIN_NL = [
  `打开 ${FIXTURE_BASE}/login`,
  '在「用户名」输入 张三',
  '在「密码」输入 p1',
  '在「角色」选择 管理员',
  '点击「登录」',
  '页面上应该出现文本「登录成功」',
].join('\n');

const LOGIN_STEPS = [
  { id: 'l1', action: 'goto' as const, url: `${FIXTURE_BASE}/login`, label: '打开登录页' },
  { id: 'l2', action: 'fill' as const, target: { by: 'label' as const, text: '用户名' }, value: '张三', label: '填用户名' },
  { id: 'l3', action: 'fill' as const, target: { by: 'label' as const, text: '密码' }, value: 'p1', label: '填密码' },
  { id: 'l4', action: 'select' as const, target: { by: 'label' as const, text: '角色' }, value: 'admin', label: '选角色' },
  { id: 'l5', action: 'click' as const, target: { by: 'role' as const, role: 'button', name: '登录' }, label: '点登录' },
  { id: 'l6', action: 'expectText' as const, target: { by: 'testId' as const, testId: 'login-result' }, value: '登录成功', label: '登录成功文案' },
];

const LOGIN_ORIGIN = {
  l1: { nlLine: 1 },
  l2: { nlLine: 2 },
  l3: { nlLine: 3 },
  l4: { nlLine: 4 },
  l5: { nlLine: 5 },
  l6: { nlLine: 6 },
};

function uniq(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${String(Math.floor(Math.random() * 1000))}`;
}

async function expectStatus(caseId: string, status: string): Promise<void> {
  await expect.poll(async () => (await readNl(caseId)).status, { timeout: 20_000 }).toBe(status);
}

test.describe('A14 NL API 闭环与门禁', () => {
  test('A14-1 创建/GET/PUT/DELETE nl、生成/领取/提交/接受、validate/run/items/产物、stale 与放行', async () => {
    // 1) 创建带 nl.text 用例：draft + 派生行视图
    const created = await createCase({ name: uniq('A14-NL'), mode: 'steps', nl: { text: SIMPLE_NL } });
    expect(created.nl?.status).toBe('draft');
    expect(created.nl?.sourceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(created.nl?.lines.map((line) => line.kind)).toEqual(['instruction', 'step', 'step']);
    expect(created.nl?.lines[0]?.text).toBe(SIMPLE_NL.split('\n')[0]);
    const caseId = created.id;

    // 2) GET nl → 200
    const nl = await readNl(caseId);
    expect(nl.text).toBe(SIMPLE_NL);
    expect(nl.status).toBe('draft');
    expect(nl.origin).toBeNull();

    // 3) PUT：状态 draft、哈希变化
    const putResult = await putNl(caseId, `${SIMPLE_NL}\n# 业务备注：冒烟`);
    expect(putResult.status).toBe(200);
    const putSource = unwrap<NlSource>(putResult);
    expect(putSource.status).toBe('draft');
    expect(putSource.sourceHash).not.toBe(nl.sourceHash);

    // 4) DELETE：204，GET → 404，steps 仍为空
    const deleted = await deleteNl(caseId);
    expect(deleted.status).toBe(204);
    const gone = await getNl(caseId);
    expect(gone.status).toBe(404);
    expect(errorCodeOf(gone)).toBe('NOT_FOUND');
    expect((await readCase(caseId)).steps.length).toBe(0);

    // 5) 重新写回 NL
    const restored = await putNl(caseId, SIMPLE_NL);
    expect(restored.status).toBe(200);
    expect(unwrap<NlSource>(restored).sourceHash).toBe(created.nl?.sourceHash);

    // 6) 生成任务：queued → generating → running → ready
    const generation = await createGeneration(caseId);
    expect(generation.status).toBe('queued');
    expect(generation.sourceHash).toBe(created.nl?.sourceHash);
    await expectStatus(caseId, 'generating');
    const conflict = await createNlGeneration(caseId, {});
    expect(conflict.status).toBe(409);
    expect(errorCodeOf(conflict)).toBe('NL_GENERATION_CONFLICT');

    const queue = unwrap<{ items: NlGeneration[] }>(await listNlQueue('?limit=100&status=queued')).items;
    expect(queue.some((item) => item.id === generation.id)).toBe(true);

    const claimed = await completeQueuedGeneration(caseId, { steps: SIMPLE_STEPS, stepOrigin: SIMPLE_ORIGIN });
    expect(claimed.status).toBe('ready');
    expect(claimed.stepOrigin).toEqual(SIMPLE_ORIGIN);
    expect(claimed.generatorVersion).toBe('pw-e2e-agent/1.0.0');

    // 7) accept：唯一写 steps 路径
    const accepted = await accept(caseId, claimed.id);
    expect(accepted.mode).toBe('steps');
    expect(accepted.steps.length).toBe(3);
    expect(accepted.nl?.status).toBe('generated');
    expect(accepted.nl?.origin).toBe('agent');
    expect(Object.keys(accepted.stepOrigin ?? {})).toEqual(['s1', 's2', 's3']);

    // 8) validate + spec 预览 + run
    const validate = await validateCase(caseId);
    expect(validate.status).toBe(200);
    expect(unwrap<{ ok: boolean; stepsCount: number; rowsCount: number }>(validate)).toMatchObject({
      ok: true,
      stepsCount: 3,
      rowsCount: 0,
    });
    expect(unwrap<{ warnings: unknown[] }>(validate).warnings).toEqual([]);

    const spec = await getSpecPreview(caseId);
    expect(spec.status).toBe(200);
    const preview = unwrap<{ text: string; stepsCount: number }>(spec);
    expect(preview.text).toContain('test.describe(');
    expect(preview.text).toContain('expect(');
    expect(preview.stepsCount).toBe(3);

    const started = await startRun({ target: { kind: 'case', caseId } });
    expect(started.status).toBe(202);
    const runId = unwrap<{ id: string }>(started).id;
    const run = await waitRun(runId);
    expect(run.status).toBe('passed');
    expect(run.stats.expected).toBe(1);
    expect(run.stats.unexpected).toBe(0);

    const items = await listRunItems(runId);
    expect(items.items.length).toBe(1);
    expect(items.items[0]?.itemKey).toBe(caseId);
    expect(items.items[0]?.outcome).toBe('expected');
    const artifacts = await listRunArtifacts(runId);
    expect(artifacts.items.length).toBeGreaterThanOrEqual(3);

    // 9) stale：PUT → validate 200 + NL_STALE；run 409；allowStaleNl 放行
    const staleText = `${SIMPLE_NL}\n页面上应该出现文本「变更后」`;
    const stalePut = await putNl(caseId, staleText);
    expect(stalePut.status).toBe(200);
    expect(unwrap<NlSource>(stalePut).status).toBe('stale');

    const staleValidate = await validateCase(caseId);
    expect(staleValidate.status).toBe(200);
    const staleWarnings = unwrap<{ warnings: { code: string }[] }>(staleValidate).warnings;
    expect(staleWarnings.map((warning) => warning.code)).toContain('NL_STALE');

    const staleRun = await startRun({ target: { kind: 'case', caseId } });
    expect(staleRun.status).toBe(409);
    expect(errorCodeOf(staleRun)).toBe('NL_STALE');

    const allowed = await startRun({ target: { kind: 'case', caseId }, options: { allowStaleNl: true } });
    expect(allowed.status).toBe(202);
    const allowedRun = await waitRun(unwrap<{ id: string }>(allowed).id);
    expect(allowedRun.status).toBe('passed');

    // 10) 已 accepted 的旧 generation 再次 accept → 幂等 200（不写库，用例仍 stale；契约偏差已记录）；
    //     新 ready generation 在文本变更后无 force accept → 409 NL_STALE；force:true 可强制。
    const idempotentAccept = await acceptNlGeneration(caseId, claimed.id);
    expect(idempotentAccept.status).toBe(200);
    const idempotentCase = unwrap<{ case: { nl: { status: string }; steps: unknown[] } }>(idempotentAccept).case;
    expect(idempotentCase.nl.status).toBe('stale');
    expect(idempotentCase.steps.length).toBe(3);

    const newGen = await createGeneration(caseId);
    const newClaimed = unwrap<NlGeneration>(await claimNlGeneration(newGen.id));
    const newSubmitted = unwrap<NlGeneration>(
      await submitNlGeneration(newGen.id, {
        leaseId: newClaimed.leaseId ?? '',
        steps: SIMPLE_STEPS,
        stepOrigin: SIMPLE_ORIGIN,
        generatorVersion: 'pw-e2e-agent/1.0.0',
      }),
    );
    expect(newSubmitted.status).toBe('ready');
    // 生成后再改文本：ready 属活跃任务（NL status=generating），accept 旧结果应被拒绝
    const changedAgain = await putNl(caseId, `${staleText}\n页面上应该出现文本「再次变更」`);
    expect(unwrap<NlSource>(changedAgain).status).toBe('generating');
    const staleAccept = await acceptNlGeneration(caseId, newSubmitted.id);
    expect(staleAccept.status).toBe(409);
    expect(errorCodeOf(staleAccept)).toBe('NL_STALE');
    const forcedAccept = await acceptNlGeneration(caseId, newSubmitted.id, { force: true });
    expect(forcedAccept.status).toBe(200);
    // force 只写 steps/生成结果；accepted 记录的 sourceHash 仍是旧文本哈希 → 状态保持 stale（语义正确）
    expect(unwrap<{ case: { nl: { status: string }; steps: unknown[] } }>(forcedAccept).case.nl.status).toBe('stale');
    expect(unwrap<{ case: { steps: unknown[] } }>(forcedAccept).case.steps.length).toBe(3);
    // 已生成后再次改文本 → stale
    const staleAgain = await putNl(caseId, `${staleText}\n页面上应该出现文本「第三次变更」`);
    expect(unwrap<NlSource>(staleAgain).status).toBe('stale');

    // 11) rule 兜底默认关闭 → 403
    const rule = await createNlGeneration(caseId, { generator: 'rule' });
    expect(rule.status).toBe(403);
    expect(errorCodeOf(rule)).toBe('NL_RULE_FALLBACK_DISABLED');

    // 12) 未生成（draft）即 validate/run → 422 NL_NOT_GENERATED
    const draftCase = await createCase({ name: uniq('A14-Draft'), mode: 'steps', nl: { text: SIMPLE_NL } });
    const draftValidate = await validateCase(draftCase.id);
    expect(draftValidate.status).toBe(422);
    expect(errorCodeOf(draftValidate)).toBe('NL_NOT_GENERATED');
    const draftRun = await startRun({ target: { kind: 'case', caseId: draftCase.id } });
    expect(draftRun.status).toBe(422);
    expect(errorCodeOf(draftRun)).toBe('NL_NOT_GENERATED');

    // 13) submit 非法：空结果 → 422 NL_SUBMIT_INVALID
    const emptyGen = await createGeneration(draftCase.id);
    const emptyClaim = unwrap<NlGeneration>(await claimNlGeneration(emptyGen.id));
    const emptySubmit = await submitNlGeneration(emptyGen.id, {
      leaseId: emptyClaim.leaseId ?? '',
      steps: [],
      generatorVersion: 'pw-e2e-agent/1.0.0',
    });
    expect(emptySubmit.status).toBe(422);
    expect(errorCodeOf(emptySubmit)).toBe('NL_SUBMIT_INVALID');

    const acceptedGeneration = unwrap<NlGeneration>(await getNlGeneration(caseId, claimed.id));
    expect(acceptedGeneration.status).toBe('accepted');
    saveJson(SCENARIO, 'simple-flow.json', {
      caseId,
      generation: claimed,
      acceptedCase: accepted,
      run: { id: runId, status: run.status, stats: run.stats },
      items: items.items,
      artifacts: artifacts.items,
      stale: { validate: staleWarnings, run: staleRun.body, allowed: allowedRun.status },
      rule: rule.body,
      draft: { validate: draftValidate.body, run: draftRun.body },
      submitInvalid: emptySubmit.body,
    });
  });

  test('A14-2 多步骤 6 行 6 步（select/click/断言）；ambiguous warning 不生成猜测步骤；reject/cancel', async () => {
    const created = await createCase({ name: uniq('A14-Login'), mode: 'steps', nl: { text: LOGIN_NL } });
    expect(created.nl?.status).toBe('draft');

    const generation = await generate(created.id, { steps: LOGIN_STEPS, stepOrigin: LOGIN_ORIGIN });
    expect(generation.status).toBe('ready');
    expect(generation.steps?.length).toBe(6);

    const accepted = await accept(created.id, generation.id);
    expect(accepted.steps.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(accepted.stepOrigin ?? {}).sort()).toEqual(Object.keys(LOGIN_ORIGIN).sort());

    const validate = await validateCase(created.id);
    expect(validate.status).toBe(200);
    expect(unwrap<{ ok: boolean; stepsCount: number }>(validate).ok).toBe(true);

    const started = await startRun({ target: { kind: 'case', caseId: created.id } });
    const run = await waitRun(unwrap<{ id: string }>(started).id);
    expect(run.status).toBe('passed');
    expect(run.stats.expected).toBe(1);

    // ambiguous warning：不生成该行步骤，warning 原样保留
    const changed = await putNl(created.id, `${LOGIN_NL}\n点击那个按钮`);
    expect(unwrap<NlSource>(changed).status).toBe('stale');
    const ambiguous = await createGeneration(created.id);
    const ambiguousReady = await completeQueuedGeneration(created.id, {
      steps: LOGIN_STEPS,
      stepOrigin: LOGIN_ORIGIN,
      warnings: [{ code: 'NL_TARGET_AMBIGUOUS', line: 7, message: '第 7 行「那个按钮」目标不明确，未生成步骤' }],
    });
    expect(ambiguousReady.warnings.length).toBe(1);
    expect(ambiguousReady.warnings[0]?.code).toBe('NL_TARGET_AMBIGUOUS');
    expect(ambiguousReady.warnings[0]?.line).toBe(7);
    expect(ambiguousReady.stepOrigin && Object.keys(ambiguousReady.stepOrigin)).not.toContain('l7');

    const rejected = await rejectNlGeneration(created.id, ambiguousReady.id, '第 7 行定位不明确，需人工改写');
    expect(rejected.status).toBe(200);
    expect(unwrap<NlGeneration>(rejected).status).toBe('rejected');

    // cancel：queued 任务可取消（不落库）
    const cancelGen = await createGeneration(created.id);
    const cancelled = await cancelNlGeneration(created.id, cancelGen.id);
    expect(cancelled.status).toBe(200);
    expect(unwrap<NlGeneration>(cancelled).status).toBe('cancelled');

    // 恢复原文 → 与 accepted 哈希一致 → generated
    await putNl(created.id, LOGIN_NL);
    await expectStatus(created.id, 'generated');

    saveJson(SCENARIO, 'multi-step.json', {
      caseId: created.id,
      acceptedSteps: accepted.steps.length,
      stepOrigin: accepted.stepOrigin,
      run: { id: run.id, status: run.status, stats: run.stats },
      ambiguous: ambiguousReady.warnings,
      rejected: unwrap<NlGeneration>(rejected).status,
      cancelled: unwrap<NlGeneration>(cancelled).status,
      generationList: generationItems(await listNlGenerationsForCase(created.id)).map((item) => ({
        id: item.id,
        status: item.status,
      })),
    });
  });

  test('A14-3 NL 第 5 态 invalid：租约过期 → 请求级回收（无重启）→ 重试封顶 → failed → invalid', async () => {
    const created = await createCase({ name: uniq('A14-Invalid'), mode: 'steps', nl: { text: SIMPLE_NL } });
    const generation = await createGeneration(created.id);

    // 第一次领取（5s 租约）
    const firstClaim = unwrap<NlGeneration>(await claimNlGeneration(generation.id, { leaseSeconds: 5 }));
    expect(firstClaim.status).toBe('running');
    expect(firstClaim.leaseAttempts).toBe(1);

    // 租约过期后任意请求触发请求级回收：running → queued（attempts+1），无需重启进程
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await expect
      .poll(async () => unwrap<NlGeneration>(await getNlGeneration(created.id, generation.id)).status, { timeout: 20_000 })
      .toBe('queued');
    const requeued = unwrap<NlGeneration>(await getNlGeneration(created.id, generation.id));
    expect(requeued.leaseAttempts).toBe(2);

    // 第二次领取 → attempts=3；再次过期后回收应封顶置 failed（不再无限重试）
    const secondClaim = unwrap<NlGeneration>(await claimNlGeneration(generation.id, { leaseSeconds: 5 }));
    expect(secondClaim.status).toBe('running');
    expect(secondClaim.leaseAttempts).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await expect
      .poll(async () => unwrap<NlGeneration>(await getNlGeneration(created.id, generation.id)).status, { timeout: 20_000 })
      .toBe('failed');
    const failed = unwrap<NlGeneration>(await getNlGeneration(created.id, generation.id));
    expect(failed.error?.code).toBe('NL_GENERATION_TIMEOUT');

    // NL 5 态：invalid（最近任务 failed 且无 accepted）
    await expect.poll(async () => (await readNl(created.id)).status, { timeout: 20_000 }).toBe('invalid');
    const validateRes = await validateCase(created.id);
    expect(validateRes.status).toBe(422);
    expect(errorCodeOf(validateRes)).toBe('NL_NOT_GENERATED');
    const runRes = await startRun({ target: { kind: 'case', caseId: created.id } });
    expect(runRes.status).toBe(422);
    expect(errorCodeOf(runRes)).toBe('NL_NOT_GENERATED');

    saveJson(SCENARIO, 'invalid-state.json', {
      caseId: created.id,
      generationId: generation.id,
      attempts: [firstClaim.leaseAttempts, requeued.leaseAttempts, secondClaim.leaseAttempts],
      finalGenerationStatus: failed.status,
      finalError: failed.error?.code,
      nlStatus: 'invalid',
      validate: validateRes.body,
      run: runRes.body,
    });
  });
});
