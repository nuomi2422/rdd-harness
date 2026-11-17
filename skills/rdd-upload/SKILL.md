---
name: rdd-upload
description: |-
  RDD 上传与发布纪律。Use when user wants 上传文档、上传Harness、发布门面、备份源码或清理分支。先区分对外发布和内部保存，固定来源提交、目标仓及分支，用清单逐项上传并核远端。
user-invocable: true
Metadata:
  role: "上传发布纪律"
---

# RDD 上传纪律

## 入口与职责

先读知识库现行入口与对应正文。知识库是现行工作指引主入口；本技能只管上传。对外内容是知识库或源码的有限发布版本，不成为另一套内部真源。

三个门面仓按目标用途分开：

| 仓库 | 放什么 | 不放什么 |
|---|---|---|
| nuomi2422/rdd-restart-doer | 项目介绍、已审阅的基础管线与使用入口 | 游戏完整历史、其它仓整库备份 |
| nuomi2422/rdd-harness | 可公开的Harness工具、制度、通用技能 | 私人运行台账、存档、聊天、凭据和私有配置 |
| nuomi2422/rdd-docs | 经选择的文档、知识库发布入口 | 未分级的内部知识库整包及旧配置备份 |
| nuomi2422/minecraft-numen | Numen fork，游戏源码来源之一 | 不能因叫backup便推全部研发分支或旧资产历史 |

仓库用途和实际可见性分开：每次查GitHub返回的private/default_branch/permissions。不能因为目前private就混入其它项目全史，也不自动改可见性。Dwinovo上游只拉取，禁止向上游推送。

## 固定发布区

本机发布工作树放RDD根下 publication/repos/<仓名>，只承接目标远端默认分支历史；待发清单和回执放 publication/manifests、publication/receipts，上传审阅内容放 publication/outgoing。源码开发树、游戏实例和构建目录都不是发布区。

发布工作树必须从目标远端明确SHA创建；逐文件导入已审核内容，保留许可证和署名。禁止把内部开发分支合并进门面来省事。若上传完整私有源码，应使用专用私有源码仓；目标尚未明确时先留本机bundle，不临时塞进三个门面仓。

## 怎么调用

1. 确认本轮授权范围，查每个本地仓git status、remote、branch、worktree和最近提交；先查已有同类技能/清单，避免新造上传器。
2. 读 targets.json 核固定仓名与默认分支预期；实际GitHub元信息不匹配时停止该目标，继续其它准备，不猜新目标。
3. 依知识库现行正文，在隔离发布工作树逐文件准备，检查完整diff与本轮新增提交可达的blob。只用有限模式扫描不能声称无秘密；需人工核上下文，许可证不明资产、内部正文与运行数据不公开。旧公开历史已有问题也不当继续公开的理由。
4. 清单冻结source仓/40位sourceSHA、publication仓/40位commit、targetURL/ref、文件SHA256、检查结果和授权依据。用git diff --check；代码或可执行技能跑对应有意义的检查。
5. 精确git add指定路径，git commit -F正文文件；不卷别人dirty，不add -A，不切换他人工作树。冻结后不改在飞内容。
6. 上传前检查认证，凭据只在认证进程内使用，绝不打印/落回执。401或Invalid username or token时不反复试旧token、不改remote绕过；所有待发项准备可审后提示主人恢复GitHub登录。
7. 一次只推一个完整SHA到一个refs/heads/...：普通快进或新ref。禁止--all、--mirror、--tags、force、隐式HEAD和自动换仓。已授权上传不逐文件重复审批；公开新敏感内容、改变可见性或重写历史另按既有权限。
8. 用git ls-remote查同一URL和精确ref，只有SHA一致才写已上传。连接中断/退出码非零先查远端，不能直接重推。回执逐项记实际exit、remoteSHA、完成时间；push成功不代表部署/实机效果。

以下命令在本机发布目录执行，参数由已冻结清单填入，不能猜HEAD：

~~~powershell
git -C <发布工作树> diff --check
git -C <发布工作树> show --stat <40位SHA>
git -C <发布工作树> -c push.followTags=false -c push.recurseSubmodules=no push --porcelain --no-follow-tags <精确目标URL> <40位SHA>:<精确refs/heads/分支>
git -C <发布工作树> ls-remote --exit-code --refs <精确目标URL> <精确refs/heads/分支>
~~~

参数全集：发布工作树=目标仓的独立工作树；40位SHA=本轮审阅的commit；URL/ref=targets与本轮清单共同绑定的唯一目标。任一为空不执行push。产物是 publication/manifests/<批次>.json 与 publication/receipts/<批次>.json，不写入公开正文。

## 分支清理

main整合主线、并行功能树、上游版本线、旧存档分别记录。提交时间最新不等于最完整；用merge-base/分支包含关系和准确diff判断。分支名不证明部署状态。

先保存完整refs清单和本机git bundle并verify。只清理已被明确主线包含、没有任何工作树占用、不是主线/上游/当前任务且SHA在操作前未变化的本地旧分支；先建refs/archive/<日期>/<原名>恢复引用，再按oldSHA原子删除原heads引用。恢复用git branch <原名> <archive引用>。未合入或cherry-pick关系未明的分支保留并列待核，不强行合并。远端删除、改默认分支或强改写历史须先做具体保留/取代清单，不与普通上传混为一步。

## 已遇到的坑与边界

- 2026-11盘点：本机游戏源码main领先fork默认版本线；最新完整快照却保存在基础管线仓的backup分支，默认首页看不到。后续不再交叉仓备份，用准确源码地图和目标清单。
- 内部知识库曾含旧凭据备份，当前脱敏不清除历史；公开只承接已知门面历史加审过的文件，不推内部整史。
- 主工作树常有并行会话dirty；即使文件已在git跟踪，也不等于属于本轮上传。
- Windows PowerShell读取UTF8须明确编码；中文路径wrapper用.js，提交说明用-F，秘密不进日志。
- 技能正文和配置为唯一源；DSH发现目录用链接指向本目录，不复制到Codex私有skills。安装成功须实际用DSH skill加载核对。
