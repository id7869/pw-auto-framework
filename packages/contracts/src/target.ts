/**
 * 目标定位器（`Target`）：每个字段都对应一个官方 Playwright 定位 API。
 * 权威来源：docs/api-contract.md §2.2 与附录 A.3；官方 API 见 playwright.dev/docs/locators。
 *
 * 只允许官方有文档的选择器族：getByRole / getByTestId / getByLabel /
 * getByPlaceholder / getByText / getByAltText / getByTitle / locator(css)。
 */

import { z } from 'zod';

export const TARGET_BY = [
  'role',
  'testId',
  'label',
  'placeholder',
  'text',
  'alt',
  'title',
  'css',
] as const;

export type TargetBy = (typeof TARGET_BY)[number];

const textLike = {
  text: z.string().min(1).max(4096),
  exact: z.boolean().optional(),
};

export const targetSchema = z.discriminatedUnion('by', [
  z
    .object({
      by: z.literal('role'),
      role: z.string().min(1).max(64),
      name: z.string().max(4096).optional(),
      exact: z.boolean().optional(),
      level: z.number().int().min(1).max(6).optional(),
    })
    .strict(),
  z
    .object({
      by: z.literal('testId'),
      testId: z.string().min(1).max(1024),
    })
    .strict(),
  z.object({ by: z.literal('label'), ...textLike }).strict(),
  z.object({ by: z.literal('placeholder'), ...textLike }).strict(),
  z.object({ by: z.literal('text'), ...textLike }).strict(),
  z.object({ by: z.literal('alt'), ...textLike }).strict(),
  z.object({ by: z.literal('title'), ...textLike }).strict(),
  z
    .object({
      by: z.literal('css'),
      selector: z.string().min(1).max(2048),
    })
    .strict(),
]);

export type Target = z.infer<typeof targetSchema>;

/** 目标的可读描述（用于自动生成 test.step 标题与错误定位，不含用户数据） */
export function describeTarget(target: Target | undefined): string {
  if (!target) return '页面';
  switch (target.by) {
    case 'role':
      return target.name ? `角色 ${target.role} 名称 ${target.name}` : `角色 ${target.role}`;
    case 'testId':
      return `testId ${target.testId}`;
    case 'css':
      return `CSS ${target.selector}`;
    default:
      return `${target.by} ${target.text}`;
  }
}