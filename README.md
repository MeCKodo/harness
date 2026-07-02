# @erzhe/harness-kit

> AI-friendly repo harness —— 把工程知识变成 agent 可消费的**契约层**。

一份 `.agents/manifest.yaml` 作为单一事实源，生成各家 agent 的入口文件（`AGENTS.md` / `CLAUDE.md` / Cursor rules），并用**门禁**保证不变量、对外契约和文档不漂移。让不同的人、不同的机器上的 agent，构建出**一模一样的范式**。

> 包名 `@erzhe/harness-kit`，安装后命令行工具叫 **`harness-kit`**。

## 为什么

传统工程化（脚手架 / lint / CI）是**面向过去、面向人**的。Agent 需要的是显式、结构化、可机器消费的知识：这个仓库是什么、能跑什么、什么绝不能破、改动该看哪、哪些验证不了。`harness-kit` 把这些沉淀进 manifest，再确定性地生成与校验。

## 安装

```bash
npm i -g @erzhe/harness-kit      # 或 pnpm add -g / 直接 npx @erzhe/harness-kit
harness-kit --help
```

## 命令

```
harness-kit init             # 铺 .agents/ 骨架 + starter manifest
harness-kit sync             # manifest -> AGENTS.md / CLAUDE.md / Cursor rules / routing / modules
harness-kit doctor           # 开发态体检：补全度 / 引用路径 / 漂移 / 新鲜度 / 体量预算
harness-kit verify           # 门禁（CI）：跑不变量 + 契约 + 漂移，列出 GAPS，失败非 0 退出
harness-kit accept-contract  # 一次预期的接口变更后，记录新的契约指纹为基线
```

## 心智模型

```
.agents/manifest.yaml   (你 + agent 维护的唯一源)
        |
   harness-kit sync     (确定性生成，勿手改产物)
        v
AGENTS.md / CLAUDE.md / .cursor/rules / .agents/routing.md / .agents/modules.md
        |
   harness-kit verify   (门禁：不变量 enforcement + 契约 snapshot + 生成物/知识漂移)
        v
   exit 0 / 非 0  +  诚实的 GAPS 清单（查不了的东西绝不谎报）
```

- **不变量**：声明式正则 `enforcement`（确定性、无 LLM），或标 `manual`。
- **契约**：协议无关——`check`（跑仓库自带工具看退出码）或 `snapshot`（打印接口指纹 → CLI 存基线并 diff）。
- **新鲜度**：知识条目 / 模块卡 `binds` 源文件哈希，代码一动就告警，无需人肉维护日期。
- **GAPS**：打包 / 真网络 / 生产上传等本地验证不了的，`verify` 显式列出，绝不假装通过。

## 让 agent 来配置：onboard skill

手写 manifest 门槛高，但对 agent 是绝配。随包附带的 [`skills/erzhe-harness-init`](skills/erzhe-harness-init/SKILL.md) 引导 agent 做仓库考古、逐块跟你确认着填 manifest、再跑 `sync/doctor/verify` 到绿。把它软链到 `~/.cursor/skills/` 或 `~/.claude/skills/` 即可被发现。

## 文档

- [`SPEC-v0.md`](SPEC-v0.md) —— manifest schema + 生成/校验契约（当前 v0.2）
- [`DESIGN.md`](DESIGN.md) —— 设计决策、调研与决策日志

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test        # node:test + tsx，核心逻辑单测
pnpm build       # esbuild 打包成 dist/harness-kit.cjs 单文件可执行
pnpm exec tsx src/cli.ts verify --repo .   # 开发态直接跑，且自托管验证本仓
```

## License

MIT © [MeCKodo (二哲)](https://erzhe.me/)
