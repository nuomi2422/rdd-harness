---
name: rdd-upload
description: |-
  RDD 上传与发布。Use when 上传源码、Harness、文档或清理分支。源码与 Harness 公开开源；文档因含 API 凭据保持私有。一次一个 SHA 推一个分支，推完 ls-remote 核对。
user-invocable: true
Metadata:
  role: "上传发布纪律"
---

# RDD 上传纪律

## 东西存在哪（2026-11-22 主人确认统一）

| 内容 | 仓 | 可见性 |
|---|---|---|
| 游戏源码 | nuomi2422/minecraft-numen（Dwinovo 的 fork） | 公开 |
| Harness 工具/技能/制度 | nuomi2422/rdd-harness | 公开 |
| 文档/知识库 | nuomi2422/rdd-docs | 私有（含 API/凭据） |
| 项目唯一门面 | nuomi2422/restart-developmental-doer，master | 公开；项目地图，不再作为源码真源 |
| 公开文档 | nuomi2422/rdd-docs-public，main | 公开；从私有主库审查脱敏的发布版，全新历史 |
| 上游 | Dwinovo/minecraft-numen | 只拉不推 |

源码 minecraft-numen/main 和 Harness rdd-harness/main 默认公开。私有主库 rdd-docs/master 保留原件、敏感资料和历史，不删、不改公开权限；公开文档 rdd-docs-public/main 从中筛选、审查、脱敏，不克隆旧历史。只在主库维护，再发布投影，禁止两套正文各自演化。首发以现行架构、施工、经验和可公开验证为主；未审附件、聊天、原始敏感日志默认不发。

**唯一门面是 restart-developmental-doer/master**（注意完整拼写），不是 rdd-restart-doer。后者按主人授权废弃：先完整备份 refs/历史、核独有文件及 Issues/Release/LFS/附件，必要内容迁出后才删除远端；本机原件不删。历史上传票不改写，后续回执明确实际处置状态。

各仓 README 首屏讲清身份、上游署名/许可、职责、阅读分支、源码/文档/工具目录及互链。公开读者从门面→公开文档→源码→Harness进入，私有库不作必需入门路径。上游 Dwinovo/minecraft-numen 只拉不推；git origin/backup 是本地别名，不决定仓库身份。公开介绍不把设计、单测或上传说成已部署/有效。

## 上传

**默认动作（2026-11-21 主人明确）：** 用户已说明要整理、按这套架构上传，或从 `/actions upload` 进入时，按本纪律直接完成，不再重复问“要不要上传”。只提交本次明确范围，不借上传带上其他人的 dirty 文件。只有不可逆或改变仓库安全边界的动作另核；普通上传不是新增审批门。

1. 推之前扫凭据：模式扫描只算线索，要看上下文；密钥、token、私人台账、存档、聊天不进公开仓。
2. 一次只推一个完整 SHA 到一个 refs/heads/...；禁止 --all、--mirror、--tags、force、隐式 HEAD。
3. 推完用 git ls-remote 查同一 URL 和精确 ref，SHA 一致才算上传成功；退出码非零或断线先查远端，不直接重推。
4. 清单和回执写 publication/manifests、publication/receipts；凭据不进日志和回执。
5. 不推上游；改可见性、改默认分支、重写历史单独处理，不和普通上传混一步。
6. 门面仓只放门面，不拿 backup 分支塞整库历史。

## 许可与贡献发布（057 已批准，2026-11-22）

公开前核各文件实际许可及来源，不因仓库归属或模型作者名推定完整版权。旧MIT授权不追溯撤回，上游LGPL、MIT API、资源及第三方通知保留。Harness当前原代码仍按MIT；未来原创核心按已发布LICENSING及license-scope清单逐路径审核后采用AGPL-3.0-only，不因放入bin/app或保存AGPL全文自动覆盖旧代码。公开说明不得说AGPL禁商用或承诺免费无限算力。新贡献按各仓CONTRIBUTING/DCO知情签署，不伪造或补签他人历史签名。每次许可发布独立提交，清单区分政策变更、真实覆盖路径和未核权利，不夹带运行逻辑或改第三方许可。

## 分支清理

先存 refs 清单和 git bundle 并 verify；只清理已明确被主线包含、无工作树占用、非主线/上游/当前任务的本地分支；先建 refs/archive/<日期>/<原名> 再删原引用，恢复用 git branch <原名> <archive引用>。远端删除和强改写历史要先列保留/取代清单。

## 已遇到的坑

- 游戏源码主线一度只存在私有仓的 backup 分支和本机，公开 fork 停在 2026-11-06；源码默认公开，落点见上表。
- 主工作树常有并行会话 dirty；文件在 git 里不等于属于本轮。
- Windows PowerShell 读 UTF8 要显式编码；中文路径 wrapper 用 .js，提交说明用 -F。
- 技能正文和配置是唯一源；DSH 用 junction 指向本目录，不复制到别处。
