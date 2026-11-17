---
name: rdd-observer-camera
description: RDD/Minecraft 拍摄时选择“原版观察者附身”稳定相机的唯一入口。主人要求的旧稳定相机是 Possession（原版旁观者持续跟随同伴、额外约20个client tick请求一次位置刷新），不是 numencam 的 SHOULDER/ORBIT/LOCK 旧 rig，也不是 BodyCam 的 BODY 第三视角。用于切换、恢复与拍摄前自检；不控制被拍AI、不改任务/存档。
user-invocable: true
---

# RDD 拍摄：原版观察者附身相机（稳定版）

先分清当前相机实现，共 3 类、5 种可操作形态：

1. **Possession（原版旁观者附身）**：`/cam possess <name>` 或 cam.json `mode=OFF, possess=<name>`；server 把玩家设 SPECTATOR + `setCamera(target)`，原版附身保持镜头，额外位置刷新约每20个client tick请求一次；刷新计数不等ACK。**这是主人要的稳定相机**。
2. **BodyCam BODY**：观察者 LocalPlayer 每 tick 被客户端传送到目标身后并瞄准；旧 rig 被绕过。适合第三人称，但受目标加载/地形影响。
3. **numencam 旧 rig**：SHOULDER、ORBIT、LOCK、CINEMATIC；SHOULDER 背后射线收距+0.8格隐藏模型，窄处会拍到石壁/无人。

## 正常拍摄：只读确认，不重设机位

正常新进程入世时，现有cam.json的mode=OFF/possess=RDD可由CameraRig首次或值变化自动触发Possession（目标须已就绪）；OFF关闭旧rig/BODY不关闭附身。先cam_state确认active/matches及实际目标，再录像；已有绑定有效就不cam_shot/follow/lens/off、不清空重绑、不BODY或手动镜头TP。额外位置刷新约每20个client tick一次，计数是请求非客户端ACK，不写每tick补传。

这不是独立AutoObserver类或登录restoreCompanions；FollowRefresh是附身刷新判据，不另造第二相机。同进程退主菜单重入/首次目标未就绪失败/换目标/丢失或AllOff后不能保证自动恢复，先据实确认失效。

## 异常失效才恢复稳定相机
1. 读当前 `D:/rdd/mc/The Best of Twilight Forest/config/numen_api/cam.json`，确认 `target` 是同伴名（RDD）。
2. 让 Possession 重新绑定：把 `mode` 设为 `OFF`，`possess` 先置空并等一次配置重载，再设回 `RDD`；或游戏内执行 `/cam possess RDD`。
3. 绝不在要拍摄时调用 `cam_off`/AllOff：它会 `Possession.release()`，把镜头从同伴身上摘掉，且 cam.json 的 possess 不会自动回绑。
4. `cam_state` 自检：`possession.active=true`、`cameraMatchesTarget=true`、`positionRefreshRequests` 递增；仅 `inWorld/targetVisible` 不算。
5. 拍摄素材统一复制到 C 盘目录；原始 take 留在游戏 screenshots，不删不改。

## 边界
- 只操作相机配置/工具，不 TP/移动被拍 RDD、不挖墙、不改任务/物品/存档、不编译部署/重启游戏。
- 低渲染帧（2–5fps）如实交付，不插帧冒充 20fps；PrintWindow 静帧可能重复旧帧，构图以录像帧为准。
- 主人调镜/停拍优先；需要关服部署时先与指挥官协调资源。
