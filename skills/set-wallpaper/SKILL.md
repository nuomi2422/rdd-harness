---
name: set-wallpaper
description: |-
  桌面壁纸工具：自动读屏幕原生分辨率、按宽高比裁剪（或留黑边）、设置 Windows 桌面壁纸、
  设置后回读注册表验证是否真的落地、备份旧壁纸可一键回退、多张图按顺序轮播（每小时自动换）。
  纯 PowerShell + System.Drawing，不依赖任何插件、不需要管理员权限。
  Use when user wants 换壁纸 / 设置壁纸 / 改桌面背景 / 壁纸轮播 / 恢复旧壁纸 /
  看屏幕分辨率 / 屏幕原生分辨率是多少 / 把图设成壁纸 / 桌面背景图.
  Voice triggers: "换壁纸", "设置壁纸", "改桌面背景", "壁纸", "轮播壁纸",
  "换桌面", "恢复壁纸", "屏幕分辨率".
Metadata:
  role: "skills 级能力（操作系统侧，与 Minecraft 无关）"
  script: "E:\\新建文件夹\\rddharness\\bin\\set-wallpaper.ps1"
  bat_entry: "E:\\新建文件夹\\rddharness\\WALLPAPER.bat"
  source_dir: "C:\\Users\\lenovo\\Pictures\\Wallpapers-src"
  output_dir: "C:\\Users\\lenovo\\Pictures\\Wallpapers"
  scheduled_task: "RddWallpaperRotate（每小时一次，schtasks 创建）"
---

# set-wallpaper

打开方式（三个入口，从简单到完整）：

```powershell
# 1) 双击（最省事）—— 轮播换下一张
E:\新建文件夹\rddharness\WALLPAPER.bat

# 2) 命令行走一遍轮播 / 看屏幕
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "E:\新建文件夹\rddharness\bin\set-wallpaper.ps1" -RotateDir "C:\Users\lenovo\Pictures\Wallpapers-src"

# 3) 指定单张图
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "E:\新建文件夹\rddharness\bin\set-wallpaper.ps1" -Image "D:\pic.jpg"
```

## 参数

| 参数 | 作用 |
|---|---|
| `-Image "路径"` | 设某一张图 |
| `-FromClipboard` | 用剪贴板里的图 |
| `-RotateDir "目录"` | 轮播：按文件名顺序取下一张，计数落在 `~\.opencode-wallpaper-rotate.txt` |
| `-Mode` | `Fill`(默认,裁剪满屏) / `Fit`(留黑边) / `Stretch` / `Center` / `Tile` / `Span`(多屏拼接) |
| `-Format` | `Auto`(跟源图) / `Raw` / `Png` / `Jpg`；`-JpegQuality` 默认 92 |
| `-AllowUpscale` | 源图比屏幕小也放大到原生；**不给就只缩不放**（避免糊） |
| `-Preview` | 只出图，不碰注册表 |
| `-Restore` | 恢复 `-Restore` 之前记下的旧壁纸 |
| `-ListScreens` | 只打印所有屏幕的分辨率和位置 |
| `-NoVerify` | 跳过设置后的回读验证 |

## ★ 三个真坑（别重新踩）

1. **PowerShell 5.1 不是 DPI-aware**，`Screen.Bounds` 返回的是被系统缩放过的逻辑分辨率。
   这台机 125% 缩放：真实 **1920x1200** 会被报成 **1536x960**（80%）。
   不修的话壁纸只有 80% 分辨率，投上去是糊的。
   脚本开头 `Enable-DpiAwareness()` 用 `SetProcessDPIAware()` 修掉——**别删**。
2. **`Register-ScheduledTask`（PowerShell cmdlet）会「拒绝访问」**，
   但 `schtasks /create` 同一个任务能建成。不需要管理员权限。
3. **`.bat` 必须纯 ASCII**。`chcp 65001` 只改输出，不改 cmd.exe 读文件用的字节指针，
   走过一个多字节字符后指针就错位，后面每行首字符被吃掉（`start`→`tart`）。
   中文输出全部交给后面的 PowerShell 脚本。见 `stager.bat` 里的同一段说明。

## 设置之后一定会验证

不是「回执 rc=0 就算成功」。脚本会回读 `HKCU\Control Panel\Desktop\Wallpaper`，
逐项打印 `[OK]/[!!]`，全过才退出 0；不过就退出 1 并提示可能要注销重登。
`SystemParametersInfo` 返回 1 只说明调用没抛异常。

## 轮播已配好

- 源图 4 张：`C:\Users\lenovo\Pictures\Wallpapers-src\`
  `1-moon-night.png` / `2-stars-bubbles.png` / `3-sakura-cat.png` / `4-lake-fishing.png`
- 处理产物：`C:\Users\lenovo\Pictures\Wallpapers\rotate-01..04-*.jpg`（各约 500KB，1920x1200）
- 计划任务 `RddWallpaperRotate`：**每小时**换一次（下次运行时间看
  `schtasks /query /tn RddWallpaperRotate /v /fo LIST`）
- 产物按**序号+原名**命名，所以第二次起命中缓存，不会每小时重新压一遍 5MB 的 PNG
- 改间隔：`schtasks /change /tn RddWallpaperRotate /mo 2`（2 小时一次）
- 想加图：往源图目录丢文件，文件名带 `05-` 前缀即可排到下一位
- 删掉轮播：`schtasks /delete /tn RddWallpaperRotate /f`

## 相关

- 工具注册表（真源）：`E:\新建文件夹\rddharness\registry.json` → `tools[]` 里 `os.wallpaper`
- 门禁：`bin\harness-gate.js preflight|postflight`