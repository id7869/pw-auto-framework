/**
 * 反虚构 / 反虚假承诺扫描：
 * 1. 前端源码不得出现官方不存在的 API（PRD §8 禁止项）
 * 2. 前端文案不得承诺“一键 AI 生成/修复”“自动修复”等官方不支持的能力
 * 3. 前端不得把密钥写入源码或 localStorage（只允许白名单键前缀）
 *
 * 说明：本文件用「拼接」构造被禁字样，避免扫描器把测试自身当成违规命中。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

const sourceFiles = walk(SRC_DIR).filter(
  (file) => /\.(ts|tsx|css|html)$/u.test(file) && file !== SELF,
);

/** UI 文案与实现文件（排除测试自身：测试会讨论被禁能力以做断言） */
const uiFiles = sourceFiles.filter((file) => !/\.test\.(ts|tsx)$/u.test(file));

const FORBIDDEN_APIS: { label: string; value: string }[] = [
  { label: '不存在的数据驱动 API', value: ['test', 'each'].join('.') },
  { label: '不存在的页面动作 API', value: ['page', 'perform'].join('.') },
  { label: '官方未证实的 agent 运行 flag', value: ['--run', 'agents'].join('-') },
  { label: '仅 Git 可用的回归参数', value: ['--only', 'changed'].join('-') },
  { label: '已弃用的 npm 空壳包名', value: ['playwright-cli@', '0.262.0'].join('') },
];

const FORBIDDEN_PROMISES: { label: string; pattern: RegExp }[] = [
  { label: '一键 AI 生成/修复', pattern: new RegExp(['一键', 'AI'].join('\\s*'), 'u') },
  { label: '自动修复承诺', pattern: new RegExp(['自动', '修复'].join(''), 'u') },
  { label: '内置 AI 承诺', pattern: new RegExp(['内置', 'AI'].join('\\s*'), 'u') },
];

describe('反虚构扫描：前端源码', () => {
  it('不包含官方不存在的 API / 参数 / 包名', () => {
    const hits: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_APIS) {
        if (content.includes(forbidden.value)) hits.push(`${file}: ${forbidden.label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('不包含“一键 AI / 自动修复 / 内置 AI”等虚假承诺', () => {
    const hits: string[] = [];
    for (const file of uiFiles) {
      const content = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_PROMISES) {
        if (forbidden.pattern.test(content)) hits.push(`${file}: ${forbidden.label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('只使用固定前缀的 localStorage 键（草稿），不写入会话/密钥', () => {
    const storageWriters = uiFiles.filter((file) => readFileSync(file, 'utf8').includes('setItem('));
    expect(storageWriters.length).toBeGreaterThan(0);
    for (const file of storageWriters) {
      const content = readFileSync(file, 'utf8');
      expect(content).toContain('CASE_DRAFT_PREFIX');
      expect(content).not.toMatch(/localStorage\.setItem\(\s*['"`](?!pw-auto-framework:draft:)/u);
    }
  });

  it('源码中不出现 test.each / page.perform 等字符串（跨文件汇总）', () => {
    const all = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const forbidden of FORBIDDEN_APIS) {
      expect(all.includes(forbidden.value)).toBe(false);
    }
  });
});