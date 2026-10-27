# Mineflayer 座位（标准开源版，验证环节工具）

> 安装：2026-10-27 ｜ **PrismarineJS/mineflayer@4.39.0**（npm 标准版，无 fork、无私有改动）
> 用途：验证环节的外部观测器/驱动器——给外部编码 AI 一个「用代码玩游戏」的标准接口（论文口径：不预写游戏逻辑，
> AI 通过 mineflayer 读状态（位置/血量/背包/环境）自己写控制代码）。

## 坐标

- 库：`D:\rdd\tools\mineflayer\node_modules\mineflayer`（91 包，npm 装，锁定 4.39.0）
- Node：`D:\rdd\tools\node\node.exe`（v22.23.3）
- 例程：`smoke-connect.js`（登录+读状态）、`observer-smoke.js`（登录+读状态+挖方块+事件流）

## 实测边界（2026-10-27，杂项 #382）

| 目标 | 结果 |
|---|---|
| 原版专用服 `worldgen-flat`（1.21.1, offline, 25565） | ✅ 登录/读状态(pos/health/inventory)/挖 grass_block ok/31 事件 |
| NeoForge 客户端开放 LAN（The Best of Twilight Forest） | ❌ 进门即踢：FML 握手门（须 NeoForge brand），**标准版 mineflayer 无 FML 支持** |

结论：**mineflayer 只能连原版协议服**。RDD 的 NeoForge 实例不能直连；要用它做对照/观测，就开原版服座位
（`D:\rdd\mc\worldgen-flat` 或复制一份），别试图连 modded 客户端。

## 起停原版座位

```powershell
# 起（后台无窗）
Start-Process -FilePath 'D:\rdd\tools\jdk21\jdk-21.0.11+10\bin\java.exe' -ArgumentList '-Xmx2G','-jar','server.jar','nogui' -WorkingDirectory 'D:\rdd\mc\worldgen-flat' -WindowStyle Hidden
# 停
Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -like '*worldgen-flat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 已知坑

1. 登录时 registry 包会打一条 `PartialReadError`（protodef 对 1.21.1 registry blob 的已知误报），不影响后续读写——别当失败。
2. `bot.dig(block, forceLook, digFace)` 是 async，**没有回调参数**；把回调传进第三参会静默挂死（今天踩过）。
3. spawn 后立刻 `blockAt` 会得 null——等 ~3s 区块加载。
