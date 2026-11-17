---
name: rdd-upload
description: |-
  RDD 上传与发布。Use when 上传源码、Harness、文档或清理分支。源码与 Harness 公开开源；文档因含 API 凭据保持私有。一次一个 SHA 推一个分支，推完 ls-remote 核对。
user-invocable: true
Metadata:
  role: "上传发布纪律"
---

# RDD 上传纪律

## 东西存在哪（2026-11-18 核对）

| 内容 | 仓 | 可见性 |
|---|---|---|
| 游戏源码 | nuomi2422/minecraft-numen（Dwinovo 的 fork） | 公开 |
| Harness 工具/技能/制度 | nuomi2422/rdd-harness | 公开 |
| 文档/知识库 | nuomi2422/rdd-docs | 私有（含 API/凭据） |
| 项目门面 | nuomi2422/rdd-restart-doer | 公开（项目门面，不存放源码历史） |
| 上游 | Dwinovo/minecraft-numen | 只拉不推 |

源码和 Harness 本来就是要开源给别人用的，默认公开，不藏。文档私有只有一个原因：里面有 API/凭据，要公开先脱敏。

## 上传

1. 推之前扫凭据：模式扫描只算线索，要看上下文；密钥、token、私人台账、存档、聊天不进公开仓。
2. 一次只推一个完整 SHA 到一个 refs/heads/...；禁止 --all、--mirror、--tags、force、隐式 HEAD。
3. 推完用 git ls-remote 查同一 URL 和精确 ref，SHA 一致才算上传成功；退出码非零或断线先查远端，不直接重推。
4. 清单和回执写 publication/manifests、publication/receipts；凭据不进日志和回执。
5. 不推上游；改可见性、改默认分支、重写历史单独处理，不和普通上传混一步。
6. 门面仓只放门面，不拿 backup 分支塞整库历史。

## 分支清理

先存 refs 清单和 git bundle 并 verify；只清理已明确被主线包含、无工作树占用、非主线/上游/当前任务的本地分支；先建 refs/archive/<日期>/<原名> 再删原引用，恢复用 git branch <原名> <archive引用>。远端删除和强改写历史要先列保留/取代清单。

## 已遇到的坑

- 游戏源码主线一度只存在私有仓的 backup 分支和本机，公开 fork 停在 2026-11-06；源码默认公开，落点见上表。
- 主工作树常有并行会话 dirty；文件在 git 里不等于属于本轮。
- Windows PowerShell 读 UTF8 要显式编码；中文路径 wrapper 用 .js，提交说明用 -F。
- 技能正文和配置是唯一源；DSH 用 junction 指向本目录，不复制到别处。
