---
name: harness-check-loop
description: 在一个已接入 harness-kit 的仓库里实现需求 / 修 bug 时的"实现 -> 验证"闭环。用 plan-checks 算影响面、run-checks 跑验收、按 gap 补齐，直到真正交付。当 agent 要开始写功能代码、或 stop 钩子拦下"未验证的交付"时使用。
---

# harness-check-loop

一个 agent 在**已接入 harness-kit** 的仓库里实现需求 / 修 bug 的闭环。目标不是"跑通测试命令"，而是**证明这次改动真的交付了**：影响面被覆盖、该补的用例补了、验收通过。

harness-kit 只提供确定性弹药，不替你判断功能对不对：
- `plan-checks` —— 按 `modules[].owns` 把改动映射到模块，算出该跑哪些 `checks`，并列出**诚实的 gap**（哪块没测、没碰测试、没命中任何模块…）。只算不跑。
- `run-checks` —— 把 `plan-checks` 选出的 **capability check** 真跑一遍，持久化 passed/failed/gaps/waivers；没有实际执行的 check 不能算绿。
- `verify` —— 再查 manifest、生成物、不变量和契约，和 `run-checks` 分工互补。
- **SessionStart + Stop 钩子**（若已 `install-hooks --stop`）会记住会话开始时的代码基线，并在你**每次尝试结束时**重跑两道门禁；会话中已经 commit 的改动也不会漏。

## 心法：两半闭环

改动可分两类，闭环方式不同：

- **改老代码 / 修老需求 / 改历史逻辑** → 影响面已有回归网。`plan-checks` 会算出命中的模块和它们的 `checks`，直接 `run-checks` 验收即可。
- **加新功能 / 新 feature** → 回归网里**还没有**覆盖它的用例。光跑老测试跑不出新功能对不对。你要**先补上验收这次新行为的用例**（让它先红后绿），再让它沉淀进回归网。

判断依据看 `plan-checks` 的 gap：`missing-test-touch` / `module-without-tests` 就是在告诉你"这块新行为还没有对应测试"。

## 闭环步骤

1. **定影响面**：动手前先
   ```
   git rev-parse HEAD                 # 记为 task-start SHA；即使稍后 commit 也不会漏
   harness-kit plan-checks --repo .
   ```
   读三样：命中的模块、要跑的 checks、gap 列表。gap 的 `-> suggestion` 就是你的下一步。
2. **实现**：按 routing / modules.md 读该读的再改。改生产代码时，**同步改/补它 `tests` glob 覆盖的用例**——尤其新功能，用例要断言真实行为（请求参数、返回 response、状态与交互），不是只断言"没抛异常"。
3. **验收**：
   ```
   harness-kit run-checks --repo . --base <task-start-sha>
   harness-kit verify --repo .
   ```
   - `run-checks` 为 `verified*`，且 `verify` 退出 0 → 交付达成，进第 5 步。
   - 手动默认只看到 `no-change` 不能证明已经 commit 的任务；传第 1 步的 SHA。生命周期 hook 有自己的 SessionStart exact base，不受此限制。
   - 有失败 / blocking gap → 进第 4 步。
4. **按证据收敛**（你自己闭环，别丢回给人）：
   - `check FAILED` → 读日志尾巴，定位并修，重跑。
   - `missing-test-touch` → 在该模块 `tests` 里补覆盖本次改动的用例，重跑。
   - `module-without-tests` → 该模块没有回归网：补 `tests` glob + 基础用例（参考模块的 `playbook`）。
   - `unmapped-file` / `unmapped-required-file` → 改动落在没人 `owns/tests` 的文件：若属已有模块，补映射；若是新模块，补一张模块卡。required 范围不能静默跳过。
   - `no-checks-selected` → 命中模块没声明 `checks`：补 `checks`（capability 动词）。
   - `manual-base-required` → 工作区已干净但没有任务起点：用第 1 步记录的 SHA 重跑 `run-checks --base <sha>`。
   - 真属于本次**非目标**的覆盖类 blocking gap（`missing-test-touch` / `module-without-tests` / `unmapped-required-file`），才用 `run-checks --waive <kind> --where <输出中的 scope> --reason <为什么>` 豁免。检查未跑、配置/Git 失败等不能豁免；豁免只绑定当前代码指纹，改代码后必须重新判断。
   修完回第 3 步，直到 `run-checks` 退出码 0。
5. **交付**：用 `harness-kit evidence --repo .` 复核最终证据；手动流程里只有 `runChecksValid:true` 仍不完整，必须看到匹配的 `verifyPassed:true` 与整体 `valid:true`。若显示 `stale`，说明留证后代码又变了，回到第 3 步。只有两道门禁都绿了才算完；把改了什么、补了哪些用例、豁免了什么及原因写进交付说明。

## 拔高正确率的三根杠杆（闭环保证的是一致性，不是"意图全对"——用这些逼近意图）

- **先红后绿（bug 必做）**：修 bug 前先写一个能**复现该 bug 的失败用例**，确认它红；修完变绿。没见过红的绿，证明不了你真修好了。
- **独立复核**：实现者和验收者同一个大脑时最容易自我欺骗。让**另一个 agent / bugbot** 或另开一轮，只拿"需求 + diff"复核，别信你自己的一面之词。
- **看 diff 覆盖**：确认新增/改动的代码行真的被新用例执行到，而不是测了一堆无关的老路径。

## 红线

- ❌ 没跑 `run-checks` 就说"做完了"。stop 钩子会拦，别赌它不在。
- ❌ 为了消 gap 造假测试（`assert true`、把断言删了、无意义豁免）——那是把回归网变成安慰剂。
- ❌ 把 `run-checks` 的失败当噪音绕过去。红灯是"还没交付"，不是"可选项"。
- ❌ 明明加了新行为却只跑老回归、不补新用例。
- ❌ 把手动 `no-change` 当成“已验收 commit”。它只说明当前工作区没差异，不知道任务从哪里开始。
