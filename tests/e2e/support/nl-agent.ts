/**
 * 确定性"模拟 agent"（非模型）：按外部 harness 的合法路径调用框架 API。
 *
 * 只做协议级动作：创建生成任务 → claim（租约）→ submit（steps + stepOrigin）→（可选）accept。
 * 不调用任何模型端点，不直连浏览器；所有断言留在 spec 内。
 */
import type { Case, CaseStep, NlGeneration, NlSource } from './types.ts';
import {
  acceptNlGeneration,
  claimNlGeneration,
  createNlGeneration,
  getCase,
  getNl,
  listNlGenerationsForCase,
  submitNlGeneration,
  unwrap,
} from './api.ts';

export interface AgentSubmission {
  steps?: CaseStep[];
  code?: string | null;
  warnings?: { code: string; line: number; message: string }[];
  stepOrigin?: Record<string, { nlLine: number }>;
  datasetId?: string;
  generatorVersion?: string;
}

export interface GenerationBundle {
  generation: NlGeneration;
  acceptedCase?: Case;
}

export function generationItems(result: import('./api.ts').HttpResult): NlGeneration[] {
  return unwrap<{ items: NlGeneration[] }>(result).items;
}

/** 创建生成任务（202 queued） */
export async function createGeneration(caseId: string): Promise<NlGeneration> {
  return unwrap<NlGeneration>(
    await createNlGeneration(caseId, { generator: 'agent' }),
  );
}

/** 领取」并提交：把已有的 queued 任务推进到 ready（模拟外部 agent） */
export async function completeQueuedGeneration(caseId: string, submission: AgentSubmission): Promise<NlGeneration> {
  const list = generationItems(await listNlGenerationsForCase(caseId));
  const queued = list.filter((item) => item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (queued === undefined) throw new Error('没有可领取的 queued 生成任务');
  const claimed = unwrap<NlGeneration>(await claimNlGeneration(queued.id));
  const submitted = unwrap<NlGeneration>(
    await submitNlGeneration(queued.id, {
      leaseId: claimed.leaseId ?? '',
      steps: submission.steps ?? [],
      generatorVersion: submission.generatorVersion ?? 'pw-e2e-agent/1.0.0',
      ...(submission.stepOrigin === undefined ? {} : { stepOrigin: submission.stepOrigin }),
      ...(submission.code === undefined ? {} : { code: submission.code }),
      ...(submission.warnings === undefined ? {} : { warnings: submission.warnings }),
      ...(submission.datasetId === undefined ? {} : { datasetId: submission.datasetId }),
    }),
  );
  return submitted;
}

/** 创建并提交（一条命令完成 agent 数据路径） */
export async function generate(caseId: string, submission: AgentSubmission): Promise<NlGeneration> {
  const created = await createGeneration(caseId);
  const queued = generationItems(await listNlGenerationsForCase(caseId)).find((item) => item.id === created.id);
  if (queued === undefined) throw new Error('创建后未在列表中读到生成任务');
  const claimed = unwrap<NlGeneration>(await claimNlGeneration(queued.id));
  return unwrap<NlGeneration>(
    await submitNlGeneration(queued.id, {
      leaseId: claimed.leaseId ?? '',
      steps: submission.steps ?? [],
      generatorVersion: submission.generatorVersion ?? 'pw-e2e-agent/1.0.0',
      ...(submission.stepOrigin === undefined ? {} : { stepOrigin: submission.stepOrigin }),
      ...(submission.code === undefined ? {} : { code: submission.code }),
      ...(submission.warnings === undefined ? {} : { warnings: submission.warnings }),
      ...(submission.datasetId === undefined ? {} : { datasetId: submission.datasetId }),
    }),
  );
}

/** 提交后接受（人审门禁路径），返回新用例与实际生成任务 */
export async function accept(caseId: string, generationId: string, body: { force?: boolean } = {}): Promise<Case> {
  const result = unwrap<{ case: Case; generation: NlGeneration }>(await acceptNlGeneration(caseId, generationId, body));
  return result.case;
}

/** 生成 → 接受（常用闭环），返回 ready 任务与接受后的用例 */
export async function generateAndAccept(
  caseId: string,
  submission: AgentSubmission,
): Promise<{ generation: NlGeneration; acceptedCase: Case }> {
  const generation = await generate(caseId, submission);
  const acceptedCase = await accept(caseId, generation.id);
  return { generation, acceptedCase };
}

export async function readNl(caseId: string): Promise<NlSource> {
  return unwrap<NlSource>(await getNl(caseId));
}

export async function readCase(caseId: string): Promise<Case> {
  return getCase(caseId);
}
