---
name: erzhe-harness-init
description: 给一个仓库接入 harness-kit —— 引导 agent 做仓库考古、把隐性工程知识翻译成 .agents/manifest.yaml，再用 sync/doctor/verify 把它验证到绿。当用户说"给这个仓库配置 harness / 初始化 AI 脚手架 / 生成 AGENTS.md 契约层"时使用。
---

# erzhe-harness-init

把**当前仓库**改造成 agent 友好：产出一份填好的 `.agents/manifest.yaml`，并让 `harness-kit doctor` healthy、`harness-kit verify` 退出码 0。

CLI 只负责机械骨架 + 确定性门禁；**理解仓库、把隐性知识翻译成结构化字段**是这个 skill 里 agent 的活。

## 0. 定位 harness-kit 命令

按可用性择一，后续统一用 `harness-kit` 指代（包名 `@erzhe/harness-kit`，bin 是 `harness-kit`）：

- **推荐（零安装、永远最新）**：`npx -y @erzhe/harness-kit@latest`
- 已全局安装：`harness-kit`
- 在 harness-kit 仓内开发：`pnpm exec tsx src/cli.ts`

先跑一次 `--help` 确认可用（如 `npx -y @erzhe/harness-kit@latest --help`）。全程用同一种方式，别混用版本。

## 1. 铺骨架（若还没有 .agents/）

```
harness-kit init --repo .
```

生成 `.agents/{manifest.yaml, knowledge/, playbooks/, adoption.md}` 骨架。已存在则跳过，直接进第 2 步补全。

## 2. 仓库考古 → 填 manifest（核心）

**纪律（先读，全程遵守）：**
- **不臆造**。拿不准的字段先跟用户确认，别编。
- 每填完一大块（identity / capabilities / contracts / invariants / modules / routing），**用一两句话跟用户对齐再继续**。
- 能自动验证的就给命令（`enforcement` 正则 / 契约 `snapshot`）；验证不了的**诚实标 `manual`**，别假装能检查。
- `AGENTS.md` 有体量预算（150 行 / 700 词）——细节沉到 `.agents/`，manifest 里写精选。

按顺序逐块填 `.agents/manifest.yaml`（schema 见 harness-kit 的 `SPEC-v0.md`）：

1. **identity**：读 `README` / `package.json` / 顶层目录。填 `name`、一句话 `summary`、`scope_in` / `scope_out`（哪些该改、哪些别碰）、`upstream` / `downstream`。
2. **capabilities**：从 `package.json` scripts、`Makefile`、`justfile`、CI 配置推断常用命令（setup / build / test / dev / lint / release）。给 `run`；长驻的标 `background: true`，有副作用的标 `mutating: true`。
3. **environment**：从 `.env.example` / README 抓关键环境变量。危险的标 `secret: true`、必需的标 `required: true`。
4. **contracts**：识别对外接口——HTTP 路由文件、CLI flags、导出的公共 API、proto/schema/IDL、事件。**尽量给 `snapshot` 命令**（打印当前接口指纹到 stdout，如 `grep -oE '"/api/[^"]*"' src/routes.ts | sort -u`），CLI 会存基线并 diff。给不出自动检查的填 `manual_verify` 说明（进 GAPS）。两条纪律：(a) **过滤注释/生成物噪音**——配置里被注释掉的示例条目会污染指纹、日后清注释误报 drift，必要时先 `sed 's://.*::'` 剥注释再抓；(b) **命令含引号/正则/管道就下沉到 `.agents/checks/<id>.sh`**（脚本里 `cd` 到仓库根 + `LC_ALL=C` 保跨机字节一致），manifest 里写 `snapshot: bash .agents/checks/<id>.sh`——比把转义地狱硬塞进 YAML 干净，过滤规则也可 review。
5. **invariants**：从 `CONTRIBUTING` / 现有 `AGENTS.md` / 代码约定提炼"必须始终成立"的规则。**能写成正则的用 `enforcement`**（`forbid_pattern` / `require_pattern` + `path_glob` 限定作用域，glob 是 include-only）；否则标 `manual: true`。
6. **modules**：主要子系统各写一张模块卡：`role`、`entry`、`upstream` / `downstream`、`must_know`、`pitfalls`（常见坑——最高价值的一栏）。⚠️ `entry`（以及 knowledge 的 `binds`）必须指到**具体文件**（如 `src/index.ts`），**不能是目录**——它要 hash 文件内容做新鲜度绑定；`routing.read` 用目录则 OK。
   - **影响面字段（给"实现 -> 验证"闭环用，能填就填）**：
     - `owns`：这个模块拥有的**生产代码 glob**（如 `src/routes/**`、`app/checkout/**`）——用来把一次 diff 映射到模块。这是闭环的地基，优先填。
     - `tests`：覆盖这个模块的**测试文件 glob**（如 `test/routes/**`、`**/*.checkout.spec.ts`）——用来判断改了生产代码有没有同步补测试。
     - `checks`：这个模块变更时该跑的**验收动作**，只能是已声明的 **capability 动词**（如 `test`、`e2e`）；原始命令留在 `routing.verify` 里，别塞这里。
     - `test_touch`：`required | advisory | off`。先由你根据真实风险提议，再让人 review：默认 advisory；公共接口、核心业务、安全边界等关键模块才 required；确实不适用才 off。
     - `playbook`：指向 `playbooks/` 下一篇"怎么验收本模块改动"的文档（可选，复杂模块值得写）。
   - 不要臆造 `owns`：拿不准就少填、宁缺毋滥；`doctor` 会警告匹配 0 文件的 `owns`（说明写错了）。**别硬套"前端=UISchema、后端=HTTP"这种域模板**——按这个仓库真实的模块边界来。
7. **validation（可选，顶层）**：当"按模块选 checks"不够用时再加。
   - `checksets`：命名的可复用 check 组（`{ id: { checks: [...] } }`），配合 `run-checks --profile <id>` 用。
   - `defaults.no_match`：改动没命中任何模块 `owns` 时兜底跑的 checks；`defaults.always`：任何改动都追加的 checks。
   - `policies.test_touch_default`：旧 manifest 缺省为 advisory，保持兼容；不要擅自把全仓一刀切成 required。
   - `required_coverage`：列出绝不能成为 unmapped-file 的生产代码范围（通常是 `src/**` / `app/**`）。命中却没映射会 blocking。
   - 同样只能引用已声明的 capability 动词。
8. **routing**：把常见改动类型（修 bug / 加接口 / 改 UI / 动权限 / 发版…）各写一行：`read`（先读哪些文件）、`entry`、`dont_assume`（别瞎猜什么）、`verify`（最少验证步骤，引用 capability 动词或原始命令）。`routing.verify` 是**给人读的最小验证提示**；`modules.checks` 是**给 `run-checks` 执行的**——两者互补，别混。
9. **knowledge**：把 agent 从代码推断不出来的东西写进 `.agents/knowledge/`；重要决策建一篇 journal ADR（`knowledge/journal/NNNN-*.md`）。用 `binds` 把知识条目绑定到源文件，源文件变了会触发新鲜度告警。**只沉淀非显然的知识，别记一次性噪音或代码里显而易见的东西。**

## 3. 生成 + 验证到绿

```
harness-kit sync            # manifest -> AGENTS.md / CLAUDE.md / routing.md / modules.md
harness-kit doctor          # 补全度 / 引用路径 / 漂移 / 新鲜度 / 体量预算；按报告修
harness-kit verify          # 门禁：跑不变量 + 契约 + 漂移，并列出 GAPS
```

- `doctor` 报路径不存在 → 修 manifest 里的路径。
- 对有 `snapshot` 的契约，`verify` 会提示"baseline not set"：确认当前接口即为期望后，跑
  ```
  harness-kit accept-contract --repo .
  ```
  建立基线（这个 `.agents/contracts/*.snapshot` 要提交进 git）。
- 迭代到 **`doctor` healthy 且 `verify` 退出码 0**。

## 4. 收尾检查（交付前）

- `harness-kit verify` 退出码 0；`GAPS` 段里每一条都是**真的没法自动查**（打包 / 真网络 / 生产上传 / 人肉不变量），不是偷懒。
- `AGENTS.md` 在体量预算内（`doctor` 第 6 项会报行数/词数）。
- 把生成物 + `.agents/` + 契约基线一起提交；告诉用户：**以后改 manifest → `harness-kit sync`，别手改生成物**。
- 装上自动化门禁，让防腐烂不靠人自律：
  ```
  harness-kit install-hooks --repo .            # git 钩子：pre-commit 自动 sync、pre-push 跑 verify
  harness-kit install-hooks --repo . --stop     # Agent SessionStart + Stop 门禁（Claude Code / Cursor / Codex）
  ```
  pre-commit 自动 sync 并暂存生成物、pre-push 跑 `verify` 拦漂移；团队再把 `harness-kit verify` 放进 CI，才能真正兑现"跨人跨机一致"。若填了 `modules.owns/tests/checks`，装上 `--stop` 钩子：SessionStart 记录 exact HEAD，每次收尾都跑 `run-checks + verify`，因此会话内 commit 也不会漏（Codex 需在 CLI 里 `/hooks` 信任一次）。首个真实会话后必须跑 `harness-kit evidence`：没有记录就说明该客户端 surface 未执行项目 hooks，须作为 GAP 报告，不能宣称门禁已生效；此时手动任务要在动手前记录 `git rev-parse HEAD`，最终用 `run-checks --base <task-start-sha>`，不能把默认 `no-change` 当交付证据。

## 5. 日常维护 / 自愈（接入之后，长期靠这个防腐烂）

harness-kit 的持续价值不在首次接入，而在**代码演进时上下文不腐烂**。机制是：门禁发现漂移 → agent 自动修 → 人只 review。**别把维护活丢回给人**——你（agent）来修，人只做最后一次审查。

**触发**：`harness-kit verify` 非零，或 `doctor` 报 drift / 新鲜度告警（装了 pre-push hook 会在 push 时自动拦）。

**自愈流程（你就是那个 agent，按此做）：**
1. 跑 `harness-kit verify`，逐条读红灯——它已把"哪块过期 / 哪个契约变了 / 该 sync 还是该 accept"写清楚了。
2. 逐条处理：
   - **生成物 drift**（"AGENTS.md drifted, run sync"）→ 直接 `harness-kit sync`。
   - **knowledge 新鲜度告警**（绑定的源文件变了）→ 重新读那个源文件，判断知识是否真过时；过时就改 `.agents/knowledge/*` 或对应 manifest 字段再 sync。**没实质变化就别乱改**。
   - **契约 drift**（snapshot 变了）→ 看对应代码改动：确属**有意**改接口（有需求 / commit 佐证）才 `harness-kit accept-contract --id <id>`；拿不准是否 breaking 就**别 accept**，标给人。
   - **invariant 违规** → 按规则修代码；确认该规则已过时才动 manifest。
3. 全部处理完再 `verify` 到退出码 0。
4. **产出一份变更清单交给人 review（这是唯一的人工动作）**，至少含：
   - 改了哪些 manifest 字段 / knowledge 文件，为什么；
   - accept 了哪些契约、对应什么代码改动、是否 breaking；
   - 哪些**没动**及原因。

**红线**：
- 契约 accept 必须有据可依且**必写进给人的清单**——绝不静默 auto-accept 对外接口变更。
- 拿不准就标 GAP 交人，别用幻觉填。
- 只修真漂移，别为了凑绿去改无关内容。

## 反模式（别做）

- ❌ 手写 `AGENTS.md` / `routing.md` / `modules.md`（它们是生成物，改 manifest）。
- ❌ 把整个代码库塞进 manifest —— 只放精选的"该看哪 + 为什么 + 别假设什么"。
- ❌ 为了消灭 GAPS 硬造检查 —— 查不了就诚实标 manual。
- ❌ 一上来全仓 grep 乱猜 —— 先按 routing 读该读的。
