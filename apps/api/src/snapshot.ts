/**
 * 运行快照（内部类型，不对外暴露；用于固化「运行时可见的用例/数据集」）。
 *
 * 为什么需要快照：api-contract §2.7/§3.2 规定历史运行必须可在用例/数据集被修改或删除后
 * 仍然可读、可比对，因此运行创建时把用例（含数据集 enabled 行）整体固化进 DB。
 */

import type { CellValue, RowData, Step } from '@pw-auto/contracts';

export interface RunDatasetSnapshot {
  id: string;
  name: string;
  columns: string[];
  rows: { rowIndex: number; data: RowData }[];
}

export interface RunCaseSnapshot {
  caseId: string;
  name: string;
  mode: 'steps' | 'code';
  steps: Step[];
  code: string | null;
  tags: string[];
  /** 无数据集时为 null（单次执行） */
  dataset: RunDatasetSnapshot | null;
}

export interface RunSuiteSnapshot {
  suiteId: string;
  name: string;
  cases: RunCaseSnapshot[];
}

export interface RunSnapshot {
  kind: 'case' | 'suite';
  /** kind=case 时存在 */
  case: RunCaseSnapshot | null;
  /** kind=suite 时存在 */
  suite: RunSuiteSnapshot | null;
}

export type CellValueType = CellValue;