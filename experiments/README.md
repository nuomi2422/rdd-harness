# experiments/ · 实验目录说明

> 状态：生效 ｜ 最后核对：2026-10-26 ｜ 归属：harness（只放索引/规则，不放复盘正文）

## 这里放什么

- 每个 `run` 一个目录：`runs/<runId>/`，含 `evidence/`、`env-baseline/`、`events.log`、`result.json` 等；
- `tests/`、`cards/`、`journal/`：实验输入/输出，**不是**结论文档；
- 失败 run 也保留，别删：它是下一次实验的设计输入。

## 失败实验的 tip 写在哪

**完整复盘写 docs，不写这里**（registry 路由铁律 1）：

- 判据/结果/原因/复现 → `D:\rdd\docs\rdd-docs\rdd架构\实机验证\YYYY-MM.md` 的 V-card；
- 一行债/三态 → `D:\rdd\docs\rdd-docs\rdd架构\杂项记录\YYYY-MM.md` 的 #NNN；
- 格式与已踩坑 → `D:\rdd\docs\rdd-docs\rdd架构\自编译统一版\85-实验失败坑与写法-20261026.md`。

索引行（只一行，链到卡）：

    TIP-YYYYMMDD-NN | 症状一句话 | 真因一句话 | 护栏一句话 | 链接 V-card/#NNN

## 环境工作台（world-view）与实验台（bench）

**状态（2026-10-27）：v0 已写码、离线自测绿、未进游戏验证。**

- `bin/world-view.js`：world_probe snapshot → `world-view-<phase>.md/.json`；`--render` 离线、无 `--render` 走 MCP 采集；自测 4/4。
- `bin/bench.js`：共享账本（tips / signals / verdicts / queue / masters / health）；自测 6/6。
- `experiments/workbench.json`：9 探针 + 10 tips + 1 signal + 2 verdicts + 1 master 种子。
- 睡觉裁判 `bin/exp-night-ab.js` 由并行会话提供，本台只登记、不改。

设计与验收（冻结）：
- `D:\rdd\docs\rdd-docs\rdd架构\自编译统一版\84-环境工作台与世界源-20261026.md`（world-view 文件契约）
- `D:\rdd\docs\rdd-docs\rdd架构\自编译统一版\87-实验台-架构与封存-v0-20261027.md`（实验台整体：共建规则 / 三乘数 / 封存与进游戏验收）

常用：

    node bin\world-view.js --run <runId> --phase before --out <runDir>\evidence
    node bin\world-view.js --render <runDir>\evidence\world-before.json --run <runId> --phase before
    node bin\bench.js catalog
    node bin\bench.js tip list
    node bin\bench.js health <runDir>

**禁止**：把 fixture 标 natural；用 SUSPENDED 做 A/B 后不恢复；没冻结判据就写 verdict。

## 禁止

- 不要把总结/复盘写成新的 harness md（postflight Q4 会 BLOCK）；
- 不要用 `git add -A` 提交 runs/（大目录）——按需精确 add；
- 不要把 fixture 标成 natural，也不要把 INCONCLUSIVE 写成 PASS。
