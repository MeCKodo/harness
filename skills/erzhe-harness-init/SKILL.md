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
7. **routing**：把常见改动类型（修 bug / 加接口 / 改 UI / 动权限 / 发版…）各写一行：`read`（先读哪些文件）、`entry`、`dont_assume`（别瞎猜什么）、`verify`（最少验证步骤，引用 capability 动词或原始命令）。
8. **knowledge**：把 agent 从代码推断不出来的东西写进 `.agents/knowledge/`；重要决策建一篇 journal ADR（`knowledge/journal/NNNN-*.md`）。用 `binds` 把知识条目绑定到源文件，源文件变了会触发新鲜度告警。**只沉淀非显然的知识，别记一次性噪音或代码里显而易见的东西。**

## 3. 生成 + 验证到绿

```
harness-kit sync            # manifest -> AGENTS.md / CLAUDE.md / .cursor 规则 / routing.md / modules.md
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
- 把生成物 + `.agents/` + 契约基线一起提交；告诉用户：**以后改 manifest → `harness-kit sync`，别手改生成物**；把 `harness-kit verify` 挂进 CI / pre-commit 才能真正兑现"跨人跨机一致"。

## 反模式（别做）

- ❌ 手写 `AGENTS.md` / `routing.md` / `modules.md`（它们是生成物，改 manifest）。
- ❌ 把整个代码库塞进 manifest —— 只放精选的"该看哪 + 为什么 + 别假设什么"。
- ❌ 为了消灭 GAPS 硬造检查 —— 查不了就诚实标 manual。
- ❌ 一上来全仓 grep 乱猜 —— 先按 routing 读该读的。
