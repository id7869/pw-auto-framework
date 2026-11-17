import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticDirValue } from './HealthPage.tsx';

describe('pages/HealthPage：静态目录展示', () => {
  it('空串/null/undefined 都显示“（未配置）”，不出现空白值', () => {
    for (const value of ['', null, undefined]) {
      const output = renderToStaticMarkup(<StaticDirValue value={value} />);
      expect(output).toContain('（未配置）');
      expect(output).not.toContain('<span class="mono break-all"></span>');
    }
  });

  it('已配置的路径原样展示', () => {
    const output = renderToStaticMarkup(<StaticDirValue value="/srv/pw-auto/web" />);
    expect(output).toContain('/srv/pw-auto/web');
    expect(output).not.toContain('（未配置）');
  });
});