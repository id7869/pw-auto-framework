/**
 * 验收证据落盘：全部写入 docs/verification/evidence/<scenario>/。
 *
 * 证据类型：
 * - JSON：API 响应/运行快照/统计；
 * - 文本：官方 CLI stdout、spec 片段、报告片段；
 * - PNG：UI 截图（A1）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { EVIDENCE_DIR } from './env.ts';

export function evidenceDir(scenario: string): string {
  const dir = join(EVIDENCE_DIR, scenario);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function evidencePath(scenario: string, fileName: string): string {
  const target = join(evidenceDir(scenario), fileName);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

export function saveText(scenario: string, fileName: string, content: string): string {
  const target = evidencePath(scenario, fileName);
  writeFileSync(target, content, 'utf8');
  return target;
}

export function saveJson(scenario: string, fileName: string, data: unknown): string {
  return saveText(scenario, fileName, JSON.stringify(data, null, 2));
}

export function saveBuffer(scenario: string, fileName: string, data: Buffer): string {
  const target = evidencePath(scenario, fileName);
  writeFileSync(target, data);
  return target;
}

/** 整页截图（仅用于证据，不参与断言） */
export async function saveScreenshot(page: Page, scenario: string, fileName: string): Promise<string> {
  const target = evidencePath(scenario, fileName);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}