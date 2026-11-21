# rdd-harness — 指针驱动的 AI 工程脚手架

> 让 AI 先找到当前该用的内容，再调用合适的工具完成工作，最后留下能复核、能接手的证据。RDD Harness 是 RDD 的工程组成，不是另一套项目目标。

## 总线路

**AGENTS.md 及按需展开的子文件是核心；命令驱动工作流是辅助。**

```text
项目 AGENTS.md
  → 按用途选择稳定内容指纹
  → 展开相关模块正文与少量必要工具
  → 执行、验证、记录
  → 需要时交给其他 AI 或按纪律上传
```

入口是 [AGENTS.md](<AGENTS.md>)。它只放用途和路标；一个主题保留一份正文，文件 SHA-256 用于复核变化。目录已登记不代表宿主已经动态卸载工具 schema，实际工具可见性以会话请求为准。

## 四个工作模块

| 稳定指纹 | 用途 | 你会展开什么 |
|---|---|---|
| `rdd-harness.write.v1` | 写码、接口、构建部署 | 模块边界、工程规范、源码与制品核验 |
| `rdd-harness.verify.v1` | 验证、观察、拍摄、真实效果 | 判据、核心工具、实验与运行原证 |
| `rdd-harness.record.v1` | 记录、交接、架构与上传留痕 | 原主题、原始证据、下一步 |
| `rdd-harness.collaborate.v1` | 多 AI 拆工、跨窗交接、复核与集成 | 责任范围、交付契约、集成与未覆盖项 |

AI 按实时任务组合一个或多个模块，不默认读完整工具表、全部文档和历史。这里的稳定内容指纹是检索身份，与游戏里的 TaskFingerprint 不同。

## 命令分工

- `/align`：核心意图对齐命令。先查、提问、确认目的与范围。
- `/team-execute`：核心工程开工命令，由指定指挥官按获授权施工单组织施工。
- `/actions`：非核心指针菜单。`compress` 专做压缩指针，`docs` 整理文档，`upload` 进入上传纪律。

`/actions` 的菜单项不是核心命令，也不是 `/align` 收尾的第三个选项。菜单目录保存标题和正文指针，选中后才加载；写入或删除菜单项另走 `add/remove`。

## 工具注册与生命周期

- 核心标记只由主人在 RDD 知识库的“进游戏核心工具”正文注册或修改。
- AI 自写工具在该文的非核心登记栏自注册，写清维护者、用途、版本、判据、正反例、实际效果和替代入口。
- 生命周期：**待验 → 样例已验 → 有用（限场景）**；版本变化待复验，无效或失效保留原因和替代入口。
- `registry.json` 是工程工具目录，`tool-layers.json` 是按需发现视图；登记不等于安装、授权、模型实际收到或有效。

## 多项目地图

架构 MCP 提供项目目录：`rdd` 是 RDD 主地图，`rdd-harness` 是工程脚手架的小地图，其他项目从自己的 AGENTS.md 与地图进入。地图只登记入口、用途和原文位置，不复制或混写项目事实，不跨项目借授权。

```js
// MCP：先列项目，再选项目地图
arch_projects({})
arch_overview({ project: "rdd-harness" })
arch_detail({ project: "rdd-harness", focus: "harness-write", level: 4 })
```

## 上传纪律

源码和 Harness 默认公开；RDD 知识库因含 API 凭据保持私有。目标已明确时直接整理并上传，不重复询问；只精确提交本次范围。

1. 公开仓上传前扫描并人工核对疑似凭据，私人台账、存档和聊天不进公开仓。
2. 一次只推一个完整 SHA 到一个 `refs/heads/...`；禁止 `--all`、`--mirror`、`--tags`、强推和隐式 HEAD。
3. 推完用同一 URL、精确 ref 执行 `git ls-remote`，SHA 一致才算上传成功。
4. 清单和回执写 `publication/manifests`、`publication/receipts`，不记凭据。

完整正文见 [rdd-upload](<skills/rdd-upload/SKILL.md>)。

## 保留的工程部件

| 部件 | 用途 |
|---|---|
| `bin/harness-gate.js` | 进游戏前核目标制品与包件，退游戏后核本次记录；`selftest` 检查接线 |
| `bin/exp-card.js` | 冻结可证伪判据、正负对照与数据复算 |
| `bin/exp-runner.js` | 受控运行与原始证据归档 |
| `bin/exp-judge.js` | 只按原始证据裁决，不把回执当效果 |
| `standards.md` | 按条目查阅的工程约束 |

旧全量工具表、旧手册和旧门禁首页不再作为当前介绍入口；仍有消费者或证据价值的原件保留。当前门禁只有目标制品/包件与本次记录质量两项，不恢复旧时间锁和流程审批。

## 快速自检

```powershell
node bin/harness-gate.js selftest
node bin/exp-card.js selftest
node bin/exp-judge.js --selftest
```

这些离线测试不启动游戏，不需要 API key；它们不能证明某项游戏行为已经有效。Minecraft 实例、mods、存档、JDK/Gradle/Node、模型服务和私有知识库不在本公开仓内。

## License

MIT。判据先冻结、数据赢；设计、源码、部署、实机和效果始终分开。
