# ai-harness — domain

把"仓库的工程知识"变成一份 agent 可消费的单一真相源 `.agents/manifest.yaml`，
由 CLI 派生出各工具文件（AGENTS.md / CLAUDE.md / Cursor rules），并用可执行门禁保证一致。

## 核心机制
- **单一真相源**：手写只在 `.agents/`；`AGENTS.md` 等一律生成，带 DO-NOT-EDIT 头，改要改 manifest 再 `sync`。
- **可执行门禁**：`verify` 跑声明式 invariants（`enforce.ts`，正则/glob，无 LLM）+ 契约 check + 生成物无漂移。
- **派生防腐烂**：`knowledge.binds` / `modules.entry` 绑源文件 hash，源变即报"可能过期"，不靠人肉维护日期。
- **GAPS 诚实**：查不了的（manual 不变量 / 无 check 契约 / mutating 命令）显式列出，禁止谎报已验证。

## 设计立场（别踩）
- 反仪式：宁可字段少、留空，也不制造人肉长期维护负担。
- 不做 spec-driven 工作流引擎；能从代码算出来的（模块图）应生成，不手写。
- 更重的工具要"挣来"（见 adoption.md）：同错漏 3 次或软约定用满一周才升级成机器门禁。
