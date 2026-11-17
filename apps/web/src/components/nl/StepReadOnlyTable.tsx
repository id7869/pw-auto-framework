/**
 * 只读步骤视图（NL 用例验收后）：步骤 ← NL 行映射、动作、定位器、值、超时。
 * 不提供任何编辑控件；执行真相是服务端 steps。
 */
import type { Case } from '../../api/types.ts';
import { STEP_ACTION_META, summarizeTarget } from '../../lib/steps.ts';
import { caseStepSources } from '../../lib/nl.ts';
import { EmptyState, TableWrap } from '../ui.tsx';

export function StepReadOnlyTable({ caseItem }: { caseItem: Case }) {
  const rows = caseStepSources(caseItem);
  if (rows.length === 0) {
    return <EmptyState title="尚无步骤" description="先完成 NL 生成并接受（Accept），步骤才会写入用例。" />;
  }
  return (
    <TableWrap label="用例步骤（只读）">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">NL 行</th>
            <th scope="col">动作</th>
            <th scope="col">定位器</th>
            <th scope="col">值 / 参数</th>
            <th scope="col">超时</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ step, line, text }, index) => (
            <tr key={step.id}>
              <td>{index + 1}</td>
              <td>
                {line === null ? (
                  <span className="muted">—</span>
                ) : (
                  <>
                    第 {line} 行
                    {text ? <div className="muted cell-sub">{text}</div> : null}
                  </>
                )}
              </td>
              <td>
                {STEP_ACTION_META[step.action]?.label ?? step.action}
                <div className="muted mono cell-sub">{step.action}</div>
              </td>
              <td>{summarizeTarget(step.target)}</td>
              <td className="mono break-all">
                {step.value ?? step.url ?? step.key ?? (step.width !== undefined ? `${String(step.width)}×${String(step.height)}` : '—')}
              </td>
              <td>{step.timeoutMs === undefined ? '默认' : `${String(step.timeoutMs)} 毫秒`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}