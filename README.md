# @erzhe/harness-kit

> 给 Agent 发一句话，让它帮你把仓库变成 AI 友好的。

harness-kit 把仓库的工程知识（这是什么、怎么跑、什么不能破、改东西看哪）沉淀成一份 `.agents/manifest.yaml`，然后自动生成各家 Agent 的入口文件（`AGENTS.md` / `CLAUDE.md`），并用门禁保证它们始终一致。

---

## 最快上手

在**任意仓库**里，把这句话丢给你的 Agent（Cursor / Claude Code / Codex 通用）：

```
Onboard 本仓库到 harness-kit：跑 npx -y @erzhe/harness-kit@latest onboard，然后严格按输出执行。
```

就这一句。Agent 会：

1. 拉取最新版的 onboard skill
2. 扫描你的仓库（读 README、package.json、目录结构…）
3. 逐块跟你确认着填 `.agents/manifest.yaml`
4. 跑 `sync` / `doctor` / `verify` 直到全绿
5. 装上 git + Agent 钩子：提交前防文档漂移，Agent 结束前自动验收本次改动

全程走 `npx`，不往机器上装任何全局东西；你一发新版，所有人下次执行就用上了。

运行要求：Node.js 18 或更高版本。发布前会用打包后的 CLI 在真实 Node 18 上做 `help / doctor / verify` smoke。

---

## 初始化后你得到什么

```
你的仓库/
  AGENTS.md                    ← [生成] 跨工具入口，Agent 每次会话必读
  CLAUDE.md                    ← [生成] Claude Code 入口
  .agents/
    manifest.yaml              ← 你维护的唯一真相源
    knowledge/                 ← Agent 从代码推不出来的知识（领域、约定、决策）
    contracts/                 ← 对外接口的契约基线
    playbooks/                 ← 可复用的工作流（SKILL.md）
    routing.md                 ← [生成] 按改动类型导航：改 UI 看哪、加接口看哪
    modules.md                 ← [生成] 模块卡：每个子系统的职责/入口/坑
```

以后改工程知识 → 编辑 `manifest.yaml` → `harness-kit sync`。别手改生成物。

---

## 接入之后：自动防腐烂，人只 review

harness-kit 的长期价值不在首次接入，而在**代码演进时上下文不腐烂**——而且这件事不该靠人记命令：

- **装了钩子就无感**：git 钩子防上下文漂移；SessionStart + Stop 钩子让 Claude Code / Cursor / Codex 在结束前真正跑本次改动对应的检查。
- **漂移了让 Agent 自愈**：知识过期 / 接口契约变了，把仓库丢给 Agent 说一句 `onboard`，它会照 skill 自动考古、改 manifest/knowledge、有据才 accept 契约，最后**产出一份变更清单**。
- **你只做一个动作**：审查那份 diff，批准或打回。生产和更新都交给 Agent，人只 review。

```
代码演进 → [hook/CI] verify 红灯，指出哪块过期/哪个契约变了
        → [Agent] 自动修 + 产出变更清单
        → [你] review：批准 or 打回      ← 唯一的人工动作
```

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `harness-kit onboard` | 打印 onboard skill 给 Agent（配合 npx，永远最新、零安装） |
| `harness-kit init` | 铺 `.agents/` 骨架 + 空白 manifest |
| `harness-kit sync` | manifest → 生成 AGENTS.md / CLAUDE.md / routing / modules |
| `harness-kit doctor` | 体检：完整性 / 路径引用 / 漂移 / 新鲜度 / 体量预算 |
| `harness-kit verify` | 门禁：跑不变量 + 契约 + 漂移，列出 GAPS，失败非 0 退出 |
| `harness-kit accept-contract` | 有意变更接口后，记录新的契约指纹为基线 |
| `harness-kit install-hooks` | 装 git 钩子：pre-commit 自动 sync + pre-push verify 拦漂移 |
| `harness-kit install-hooks --stop` | 装 Agent 生命周期门禁：会话开始记基线，结束前跑 `run-checks` + `verify` |
| `harness-kit plan-checks` | 只看本次改动会影响哪些模块、该跑什么、还有哪些验证缺口 |
| `harness-kit run-checks` | 真正执行本次改动对应的检查，并保存可追溯证据 |
| `harness-kit evidence` | 查看最近一次验收状态、检查结果和豁免理由 |
| `harness-kit check-loop` | 打印给 Agent 使用的“实现 → 验收 → 修复 → 再验收”指南 |

所有命令都支持 `-C <dir>` 指定目标仓库（默认当前目录）。

## 实现之后，怎么保证真的验收了

举四个常见场景：

- **修旧 bug**：Agent 改了生产代码，却没补回归测试。关键模块配置为 `test_touch: required` 后，结束时会直接拦住，直到补测试；若测试确实不适用，可对这个覆盖缺口留下有范围、有理由的豁免。
- **代码已经 commit**：门禁从会话开始时记住基线，所以不会因为 `HEAD` 前进就误判“没有改动”。
- **客户端 hook 没触发**：手动开始任务时先记下 `git rev-parse HEAD`；若中途已经 commit，用 `run-checks --base <task-start-sha>` 验收。未提供任务起点的手动 `no-change` 不算交付证据。
- **检查根本没跑**：命令不存在、被标成后台任务/有副作用、Git base 无效或 manifest 写坏，都算 `not-verified`，不会再用“跳过”冒充成功。

项目接入时，由 Agent 根据模块风险提议策略，人来 review：默认只是提醒；公共接口、核心逻辑等关键模块再设为强制。每次结果会落到当前 worktree 的私有 Git 状态里，`harness-kit evidence` 随时可查。只有“没补测试 / 模块暂时没测试 / 必需范围未映射”这三类覆盖缺口可豁免；检查没跑、配置写坏、Git 对比失败等系统问题不能绕过。豁免只对当前代码指纹有效，代码一变就失效。

注意：客户端显示“hook 已安装”不等于它真的执行过。第一个真实会话结束后要跑一次 `harness-kit evidence`；没有记录就按 GAP 处理。JSON 里的 `hookActive` 只表示这条 7 天内的证据确实由 hook 产生且两道门都通过，不代表持续探测客户端安装状态。当前部分 Codex linked-worktree 和 Cursor headless/cloud 版本存在上游生命周期 hook 兼容问题，CLI 会尽量告警，但不会伪造成功证据。

`evidence` 不是旧绿灯截图：每次读取都会重新核对当前代码，代码一变就标 `stale` 并返回失败。手动执行时，`run-checks` 只会得到 `runChecksValid`；随后对同一代码运行 `verify`，整体 `valid` 才会变成 true。若会话开始时工作区已经有未提交改动，门禁会把这些既有改动也纳入验收范围，并在 evidence 里列出；它保证不漏，不冒充精确的任务归因。

测试文件按最终工作树状态判断：只有新增或修改才满足 `test_touch`，哪怕先暂存修改、随后又删除，也不会被当成“补过测试”。改动指纹还包含可执行位与 submodule 当前提交/脏状态，避免代码内容没变时误沿用旧证据。自动 checks 最多共享 7 分钟，随后 `verify` 最多 2 分钟，确保在客户端 10 分钟 hook 上限前仍能返回明确的拦截结果；超时本身就是失败。

---

## 它解决什么问题

传统工程化（脚手架 / lint / CI）是**面向人、面向过去**的。Agent 需要的是显式、结构化、可机器消费的知识：

- **这是什么** → `identity`（name / summary / scope）
- **怎么跑** → `capabilities`（setup / build / test / dev…）
- **什么绝不能破** → `invariants`（声明式正则门禁）+ `contracts`（接口指纹基线）
- **改东西看哪** → `routing`（按改动类型导航）+ `modules`（模块卡）
- **哪些验证不了** → `GAPS`（诚实标注，绝不谎报）

harness-kit 把这些沉淀进 manifest，再确定性地生成与校验。

---

## 工作原理

```
.agents/manifest.yaml ──sync──> Agent 入口 / 路由 / 模块图
          │
          └── 本次 diff ──plan-checks──> 影响模块 + checks + gaps
                                      │
                                      └──run-checks + verify──> evidence / 继续修
```

- **不变量**：声明式正则 `enforcement`（确定性、无 LLM），或标 `manual`
- **契约**：`snapshot` 打印接口指纹 → CLI 存基线并 diff（协议无关）
- **新鲜度**：知识条目 `binds` 源文件哈希，代码一动就告警
- **GAPS**：打包 / 真网络 / 生产上传等本地验证不了的，显式列出

---

## 让 Agent 自动触发（可选）

上面的"最快上手"是**显式调用**——你每次说"onboard 本仓库"，Agent 才会做。如果你想让某个 Agent **自动识别**"该给仓库接 harness-kit"，可以把 skill 软链进它的 skill 目录：

```bash
# Cursor
ln -sf "$(npm root -g)/@erzhe/harness-kit/skills/erzhe-harness-init" ~/.cursor/skills/

# Claude Code
ln -sf "$(npm root -g)/@erzhe/harness-kit/skills/erzhe-harness-init" ~/.claude/skills/
```

这样当用户说"给这个仓库配置 harness"时，Agent 会自动找到并执行这个 skill。

---

## 开发

```bash
pnpm install
pnpm typecheck          # tsc --noEmit
pnpm test               # node:test + tsx
pnpm build              # esbuild → dist/harness-kit.cjs
pnpm exec tsx src/cli.ts verify --repo .   # 自托管验证
```

## 文档

- [`SPEC-v0.md`](SPEC-v0.md) — manifest schema + 生成/校验契约

## License

MIT © [MeCKodo (二哲)](https://erzhe.me/)
