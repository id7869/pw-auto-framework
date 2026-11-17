/**
 * 中文校验消息：zod 默认英文，契约要求 message 可直接展示给中文用户（api-contract §0.2）。
 * 在合同包加载时统一配置，前后端共享同一套中文文案。
 */

import { z } from 'zod';

let configured = false;

export function configureChineseValidationMessages(): void {
  if (configured) return;
  configured = true;
  z.config(z.locales.zhCN());
}