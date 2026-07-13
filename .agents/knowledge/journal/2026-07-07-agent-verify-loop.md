# ADR 2026-07-07 — Agent「实现 → 验收」loop 的边界与机制

## 背景

诉求：Agent 在任意仓库改完代码（bugfix / 历史代码 / 新需求）后，需要一个
「实现 → 验收 → 不过再修 → 直到通过」的闭环。问题是：这个 loop 该不该、以及
哪一部分该放进 harness-kit（一个跨 FE/BE/client 的通用工具）。

多轮讨论 + 参考了 Codex 的 acceptance/Validation Planner 提案后达成的共识如下。

## 决策：把 loop 拆成 4 个时刻，只有确定性部分进 harness

- **T0 配置生成（进 harness，声明式）**：onboard 时 agent 扫仓库提议、人确认，
  把「影响面 + 如何测」写进 manifest。复用现有 `modules[]`，不新造 `surfaces`：
  - `modules[].owns`（新增）：归属 glob，用于 diff 匹配
  - `modules[].tests`（新增）：该模块对应的测试文件 glob
  - `modules[].checks`（新增）：该模块改动后要跑的 check（引用 capabilities）
  - `modules[].test_touch`（新增）：`required | advisory | off`；默认 advisory，关键模块才 required
  - `modules[].playbook`（新增，可选）：指向 `.agents/playbooks/*.md` 的自由文本模板引用
  - `validation.checksets` / `defaults`：可复用的 check 组合（采纳 Codex 这部分）
  - 「如何测」分两层：命令（项目专属，配 capabilities）/ 该测哪几类场景（模板，放 playbook）

  **schema 而非 taxonomy（关键纠正）**：harness 只定义"面/测试模板"的**形状**，绝不枚举
  验证种类。module 不带类型（没有 ui/http/rpc 之分），playbook 是自由文本 doc，harness
  只认 glob + command + doc-ref。前端也有无 UI 的逻辑面、后端也有 RPC 而非 HTTP——面的
  拆分与模板内容全由项目定义。verify-http-endpoint / verify-ui-component 之类只是**项目可能
  写的内容示例**，不是 harness 内建字段。判定红线：**harness 只枚举「自己机制的有限状态」
  （gap 种类），永不枚举「领域的验证种类」（无限，属项目）。**

- **T1 影响面计算（进 harness，纯确定性）**：`plan-checks --base <ref> --json`
  安全调用 Git、覆盖 committed/staged/unstaged/untracked，再与 `modules[].owns/tests` 匹配 → 命中模块 → 合并 checks + 选中原因。
  盲区（跨模块传播、命中文件不属任何模块）必须诚实标进 GAP，禁止谎报安全。

- **T2 验收（混合，case 代码不由 harness 生成）**：
  - 老需求/回归：case 已存在 → `run-checks` 直接跑（确定性）。
  - 新需求：case 不存在 → harness 只给「该测什么」的 playbook 模板 +「跑的能力」，
    针对本次改动的**具体测试代码由 agent 在 loop 里实例化**（语义活，天生非确定性）。
  - **保证机制 = change↔test 对应门禁**（关键，见下）。

- **T3 沉淀（闭环，系统随每轮变强）**：agent 为新功能写的 case 落进 `tests` glob 覆盖的
  目录 → 下次 plan-checks 自动匹配 → 新需求的验收产物自动变成老需求的回归网。
  自动变长是 T2 对应门禁的**后果**，不是单独功能。

## 保证机制：change↔test 对应门禁（T2 的核心）

「保证每次改动都验收」不能靠 skill 文本自觉，必须靠确定性门禁。plan-checks/run-checks 判定：

- 命中某影响面的**生产文件**变了，但该面的 `tests` glob **没有任何文件被 touch**
  → 按 `test_touch` 报 blocking / advisory / off：关键模块必须补 case 或显式记录豁免，普通模块默认提醒。
- 影响面根本没声明 `tests` → 报「未覆盖影响面」GAP（典型是历史遗留代码）。
- policy 按稳定模块风险声明，而不是运行时猜“需求类型”：onboarding agent 提议、人 review；旧 manifest 缺省 advisory。

门禁只能保证**「对应 + 执行 + 诚实上报」**，无法保证 case 语义正确/有意义——
后者永远是 agent/人的活。这是诚实天花板，不掩盖。

**gap 必须自带补救建议（GAPS 机制升级）**：每个 gap 不只是"这里有洞"，而是结构化的
`{ kind, where, why, suggestion }`。suggestion 由 gap kind 确定性渲染（用该面已声明的
tests glob / playbook 引用填模板），可被 `modules[].remediation` 覆盖。例：未覆盖面 →
"在 {tests_glob} 下补测试，参考 playbook {ref}"；改了生产没碰测试 → "补覆盖本次改动的
case，或用 --waive 记录豁免原因并入 gaps"。这沿用 harness 已有的做法（contract 的
manual_verify、snapshot baseline 的 "run accept-contract"），只是推广到所有 gap。
harness 只确定性地给出"下一步脚手架"，具体测什么内容仍是 playbook + agent 的活。

## loop 在哪编排：三层分工，skill 只是指挥不是大脑

用户正确地指出「单个 skill 太简单」。修正不是把 skill 写厚，而是把智能下沉到确定性/声明式层：

- **确定性判据层（harness CLI）**：plan-checks / run-checks，出影响面 + 证据 + 退出码。门禁在这。
- **规格/模板层（manifest + playbooks）**：项目声明 owns/tests/checks；playbook 存
  各项目类型的验收模板（verify-http-endpoint / verify-ui-component / verify-cli-command …）。
  **通用性来自这一层可插拔**，不来自 skill 变聪明。
- **编排层（SKILL.md + agent 引擎）**：薄的流程文本 + agent 自身迭代当引擎。
  停止条件 = run-checks 为 verified* 且 verify 通过；证据已持久化。手动 `no-change` 只说明工作区干净，
  不知道任务起点，不能证明已 commit 的交付；无 lifecycle session 时必须在动手前记录 task-start SHA。

生命周期执行由 SessionStart + Stop hooks 保证：开始保存 exact HEAD，结束时每次重跑 `run-checks + verify`。
Claude/Codex 用 stdout `decision=block`，Cursor 用 stdout `followup_message`。状态和 scoped waiver 存在 Git admin dir，
latest 指针再按 harness target 隔离，因此 worktree/target 不串证据、会话内 commit 不丢，且代码指纹变化会让旧 waiver 自动失效。
Git diff 同样按 target 裁剪并去掉前缀，使 package 内 manifest 的 `src/**` 等 glob 始终看到 target-relative 路径。

可靠性细节：同 session resume 不重置最初 base；fingerprint 分开覆盖 Git index 与 worktree，避免 staged/unstaged
互相抵消，并覆盖可执行位、submodule 当前 commit/脏状态；checks 后和 verify 后都重算，防检查命令或并发编辑污染证据。
`evidence` 读取时再重算一次，旧绿灯遇到新代码会变 stale。手动 evidence 只有在同一指纹的 `run-checks + verify`
都通过时才整体 valid。SessionStart 已 dirty 时采用安全 superset（从 HEAD 到最终树全部验），不声称精确任务归因。
自动 checks 共用 7 分钟预算，verify 的仓库命令共用 2 分钟预算，给 10 分钟客户端 hook 留出协议回传时间；
任何超时都必须在客户端杀死 runner 前转成 blocking 协议。测试 touch 只接受新增/修改，删除测试不能消掉缺口。

## 明确不做

- 不在 verify 里跑项目测试（保住「便宜、确定、CI 门禁」定位）。
- 不做 LLM 影响面推断 / test impact analysis（依赖图是 nx/turbo 的活）。
- 不由 harness 生成测试代码（语义活）。
- 不按 feature 无限加规则；增长边界是稳定模块，靠 doctor 预算告警兜底。

## 状态

已于 2026-07-11 落地：schema、fail-closed planner/runner、持久化 evidence/scoped waiver、
三种 Agent 生命周期适配、四个 doctor-healthy 示例与协议回归测试。真实 Claude Code 已确认触发并留证；
当前 Codex linked-worktree / project-hook 与 Cursor headless surface 未稳定触发，installer 必须提示用 evidence 复核，
不能用协议模拟冒充已验证。
