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

## 环境工作台（world-view）

**现状：AI 仍在使用旧方式**——每个 AI 自己 `world_probe` 若干探针、自己读 `monitor/*.jsonl`/`latest.log`、用 sleep 等时序；`world-view.js` 尚未实现。

设计与验收（冻结）：`D:\rdd\docs\rdd-docs\rdd架构\自编译统一版\84-环境工作台与世界源-20261026.md`。

目标：harness 在 before/after/death/review 四个时点生成一份 `env/world-view.md` + `world-view.json`，所有 AI 只读这一份，不再逐探针重查。

## 禁止

- 不要把总结/复盘写成新的 harness md（postflight Q4 会 BLOCK）；
- 不要用 `git add -A` 提交 runs/（大目录）——按需精确 add；
- 不要把 fixture 标成 natural，也不要把 INCONCLUSIVE 写成 PASS。
