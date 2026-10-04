#requires -Version 5.1
<#
  set-wallpaper.ps1 —— 设壁纸（纯 PowerShell，不需要任何插件）
  用法示例:
    .\set-wallpaper.ps1 -Image "D:\pic.jpg"
    .\set-wallpaper.ps1 -Image "D:\pic.jpg" -Mode Fit
    .\set-wallpaper.ps1 -FromClipboard
    .\set-wallpaper.ps1 -ListScreens
    .\set-wallpaper.ps1 -Preview -Image "D:\pic.jpg"      # 只出图不设置
    .\set-wallpaper.ps1 -Restore                          # 恢复到上次设置前的壁纸
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Image,

    [ValidateSet('Fill', 'Fit', 'Stretch', 'Center', 'Tile', 'Span')]
    [string]$Mode = 'Fill',

    [ValidateSet('Auto', 'Raw', 'Png', 'Jpg')]
    [string]$Format = 'Auto',

    [int]$JpegQuality = 92,

    [string]$OutDir = "$env:USERPROFILE\Pictures\Wallpapers",

    # 轮播：给一个目录，按文件名顺序取"下一张"。计数落在 ~/.opencode-wallpaper-rotate.txt
    [string]$RotateDir,

    [switch]$FromClipboard,
    [switch]$Preview,
    [switch]$Restore,
    [switch]$ListScreens,
    [switch]$AllowUpscale,
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$StateFile = Join-Path $env:USERPROFILE '.opencode-wallpaper-state.json'
$RotateCounter = Join-Path $env:USERPROFILE '.opencode-wallpaper-rotate.txt'
$script:spiReady = $false

# PowerShell 5.1 不是 DPI-aware，Screen.Bounds 会返回被缩放过的逻辑分辨率
# （这台机 125% 缩放：真实 1920x1200 会被报成 1536x960），必须先打开 DPI 感知，
# 否则生成的壁纸只有 80% 分辨率，投上去是糊的。
function Enable-DpiAwareness {
    try {
        if (-not ('Opencode.Native.Dpi' -as [type])) {
            Add-Type -Namespace 'Opencode.Native' -Name 'Dpi' -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
        }
        [void][Opencode.Native.Dpi]::SetProcessDPIAware()
    } catch {
        Write-Warning ("开启 DPI 感知失败: {0}（分辨率可能读成逻辑像素，壁纸会偏糊）" -f $_.Exception.Message)
    }
}

function Initialize-Spi {
    if ($script:spiReady) { return }
    if (-not ('Opencode.Native.Win32' -as [type])) {
        Add-Type -Namespace 'Opencode.Native' -Name 'Win32' -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
'@
    }
    $script:spiReady = $true
}

function Get-Screens {
    [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [pscustomobject]@{
            DeviceName = $_.DeviceName
            Primary    = [bool]$_.Primary
            X          = [int]$_.Bounds.X
            Y          = [int]$_.Bounds.Y
            W          = [int]$_.Bounds.Width
            H          = [int]$_.Bounds.Height
        }
    }
}

function Show-Screens {
    $screens = Get-Screens
    Write-Host ''
    Write-Host ('屏幕数量: {0}' -f @($screens).Count) -ForegroundColor Cyan
    $screens | ForEach-Object {
        Write-Host ('  {0,-10} {1,5}x{2,-5} @ ({3},{4}){5}' -f `
            $_.DeviceName, $_.W, $_.H, $_.X, $_.Y, $(if ($_.Primary) { '  <- 主屏' } else { '' }))
    }
    return $screens
}

function Get-TargetBox {
    param($Screens)
    $primary = $Screens | Where-Object { $_.Primary } | Select-Object -First 1
    if ($null -eq $primary) { $primary = $Screens | Select-Object -First 1 }
    if ($Mode -eq 'Span') {
        $minX = ($Screens | Measure-Object -Property X -Minimum).Minimum
        $minY = ($Screens | Measure-Object -Property Y -Minimum).Minimum
        $maxX = ($Screens | ForEach-Object { $_.X + $_.W } | Measure-Object -Maximum).Maximum
        $maxY = ($Screens | ForEach-Object { $_.Y + $_.H } | Measure-Object -Maximum).Maximum
        return [pscustomobject]@{ W = [int]($maxX - $minX); H = [int]($maxY - $minY) }
    }
    return [pscustomobject]@{ W = $primary.W; H = $primary.H }
}

function Save-Image {
    # $SrcFormatGuid 必须传**源图**的 RawFormat.Guid。
    # 传处理后的 Bitmap 会拿到 MemoryBMP，Auto 分支就永远判不出 JPEG -> 全存成 PNG。
    param([System.Drawing.Image]$Img, [string]$Path, [Nullable[Guid]]$SrcFormatGuid)

    $jpgGuid = [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid
    $pngGuid = [System.Drawing.Imaging.ImageFormat]::Png.Guid

    $ext = switch ($Format) {
        'Png'  { '.png' }
        'Jpg'  { '.jpg' }
        'Raw'  { if ($SrcFormatGuid -and $SrcFormatGuid.Value -eq $jpgGuid) { '.jpg' } else { '.png' } }
        default {
            if     ($SrcFormatGuid -and $SrcFormatGuid.Value -eq $jpgGuid) { '.jpg' }
            elseif ($SrcFormatGuid -and $SrcFormatGuid.Value -eq $pngGuid) { '.png' }
            else { '.png' }
        }
    }
    $Path = [System.IO.Path]::ChangeExtension($Path, $ext)

    if ($ext -eq '.jpg') {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                 Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $parms = New-Object System.Drawing.Imaging.EncoderParameters 1
        $parms.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter `
            ([System.Drawing.Imaging.Encoder]::Quality), ([long]$JpegQuality)
        $Img.Save($Path, $codec, $parms)
        $parms.Dispose()
    } else {
        $Img.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    return $Path
}

function Convert-ForFill {
    param([System.Drawing.Image]$Src, [int]$Tw, [int]$Th)

    $srcAspect = $Src.Width / [double]$Src.Height
    $dstAspect = $Tw / [double]$Th

    $cw = $Src.Width; $ch = $Src.Height; $cx = 0; $cy = 0
    if ($srcAspect -gt $dstAspect) {
        $cw = [int][math]::Round($Src.Height * $dstAspect)
        $cx = [int][math]::Round(($Src.Width - $cw) / 2)
    } else {
        $ch = [int][math]::Round($Src.Width / $dstAspect)
        $cy = [int][math]::Round(($Src.Height - $ch) / 2)
    }
    $rect = [System.Drawing.Rectangle]::new($cx, $cy, $cw, $ch)

    $bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.DrawImage($Src, [System.Drawing.Rectangle]::new(0, 0, $rect.Width, $rect.Height), $rect, [System.Drawing.GraphicsUnit]::Pixel)
    } finally {
        $g.Dispose()
    }
    return $bmp
}

function Get-ClipboardImage {
    if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
        throw '剪贴板里没有图片。先复制一张图再试，或改用 -Image 指定文件。'
    }
    return ([System.Windows.Forms.Clipboard]::GetImage()).Clone()
}

function Set-DesktopWallpaper {
    param([string]$Path, [int]$Style, [bool]$Tile)

    $key = 'HKCU:\Control Panel\Desktop'
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }

    Set-ItemProperty -Path $key -Name 'WallpaperStyle' -Value ([string]$Style) -Type String
    Set-ItemProperty -Path $key -Name 'TileWallpaper'  -Value $(if ($Tile) { '1' } else { '0' }) -Type String
    Set-ItemProperty -Path $key -Name 'Wallpaper'      -Value $Path -Type String

    Initialize-Spi
    $SPI_SETDESKWALLPAPER = 0x0014
    $SPIF_UPDATEINIFILE  = 0x0001
    $SPIF_SENDCHANGE     = 0x0002
    $rc = [Opencode.Native.Win32]::SystemParametersInfo(
        $SPI_SETDESKWALLPAPER, 0, $Path, ($SPIF_UPDATEINIFILE -bor $SPIF_SENDCHANGE))
    return $rc
}

function Test-WallpaperApplied {
    param([string]$Expected, $Screens)

    $reg = (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'Wallpaper' -ErrorAction SilentlyContinue).Wallpaper
    $checks = @()
    $checks += [pscustomobject]@{ 项 = '文件存在'; 结果 = (Test-Path -LiteralPath $Expected); 详情 = $Expected }
    $checks += [pscustomobject]@{ 项 = '注册表路径一致'; 结果 = ($reg -eq $Expected); 详情 = $reg }
    $ok = $true
    $checks | ForEach-Object { if (-not $_.结果) { $ok = $false } }
    [pscustomobject]@{ 全部通过 = $ok; 明细 = $checks }
}

function Save-OldState {
    $key = 'HKCU:\Control Panel\Desktop'
    $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    $state = [pscustomobject]@{
        Wallpaper     = $p.Wallpaper
        WallpaperStyle = $p.WallpaperStyle
        TileWallpaper  = $p.TileWallpaper
        SavedAt        = (Get-Date).ToString('s')
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
    return $state
}

# ---------------------------------------------------------------- 主流程
Enable-DpiAwareness

if ($ListScreens) {
    $null = Show-Screens
    return
}

if ($Restore) {
    if (-not (Test-Path -LiteralPath $StateFile)) {
        throw "找不到备份状态文件: $StateFile （说明之前没记录过，先正常设一次壁纸）"
    }
    $old = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($old.Wallpaper)) { throw '备份里的 Wallpaper 路径为空，无法恢复。' }
    if (-not (Test-Path -LiteralPath $old.Wallpaper)) {
        throw "备份里的文件已不存在: $($old.Wallpaper)"
    }
    $style = 10; if ($old.WallpaperStyle) { $style = [int]$old.WallpaperStyle }
    $rc = Set-DesktopWallpaper -Path $old.Wallpaper -Style $style -Tile ($old.TileWallpaper -eq '1')
    Write-Host ("已恢复: {0}  (SystemParametersInfo rc={1})" -f $old.Wallpaper, $rc) -ForegroundColor Green
    return
}

$screens = Show-Screens
$box = Get-TargetBox -Screens $screens
Write-Host ("目标画布: {0}x{1}   模式: {2}" -f $box.W, $box.H, $Mode) -ForegroundColor Cyan
Write-Host ''

# ---- 轮播选图：先定下 $Image，后面就不用手工指定了 ----
$rotateFiles = $null
$rotateIdx = -1
$rotateRun = 0
if (-not [string]::IsNullOrWhiteSpace($RotateDir)) {
    if (-not (Test-Path -LiteralPath $RotateDir)) { throw "轮播目录不存在: $RotateDir" }
    $rotateFiles = @(Get-ChildItem -LiteralPath $RotateDir -File -ErrorAction Stop |
                     Where-Object { $_.Extension -match '^\.(png|jpe?g|bmp|gif|tiff?|webp)$' } |
                     Sort-Object Name)
    if ($rotateFiles.Count -eq 0) { throw "轮播目录里没有图片: $RotateDir" }

    $n = 0
    if (Test-Path -LiteralPath $RotateCounter) {
        $raw = (Get-Content -LiteralPath $RotateCounter -Raw -ErrorAction SilentlyContinue)
        if (-not [string]::IsNullOrWhiteSpace($raw)) { [void][int]::TryParse($raw.Trim(), [ref]$n) }
    }
    $rotateRun = $n + 1
    Set-Content -LiteralPath $RotateCounter -Value $rotateRun -Encoding ASCII
    $rotateIdx = ($rotateRun - 1) % $rotateFiles.Count
    $Image = $rotateFiles[$rotateIdx].FullName
    Write-Host ("轮播第 {0} 次 -> 第 {1}/{2} 张: {3}" -f $rotateRun, ($rotateIdx + 1), $rotateFiles.Count, $rotateFiles[$rotateIdx].Name) -ForegroundColor Magenta
    Write-Host ''
}

# 取源图
$src = $null
$ownedClipboard = $false
try {
    if ($FromClipboard) {
        if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
            throw '剪贴板里没有图片。'
        }
        $data = [System.Windows.Forms.Clipboard]::GetImage()
        $stream = New-Object System.IO.MemoryStream
        $data.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("oc-clip-{0}.png" -f (Get-Random))
        $stream.Save($tmp)
        $stream.Dispose()
        $data.Dispose()
        $src = [System.Drawing.Image]::FromFile($tmp)
        $ownedClipboard = $true
    } else {
        if ([string]::IsNullOrWhiteSpace($Image)) {
            throw '没给图片。用 -Image "路径"、-RotateDir "目录"，或用 -FromClipboard 读剪贴板。'
        }
        $resolved = (Resolve-Path -LiteralPath $Image -ErrorAction Stop).ProviderPath
        if (-not (Test-Path -LiteralPath $resolved)) { throw "文件不存在: $resolved" }
        $src = [System.Drawing.Image]::FromFile($resolved)
        Write-Host ("源图: {0}  ({1}x{2})" -f $resolved, $src.Width, $src.Height) -ForegroundColor DarkGray
    }

    if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    # 轮播用稳定文件名（按序号+原名），这样缓存命中、也不会每小时堆一个新文件
    $baseName = if ($rotateFiles) { 'rotate-{0:D2}-{1}' -f ($rotateIdx + 1), $rotateFiles[$rotateIdx].BaseName }
                else { 'wallpaper-{0}-{1}' -f $Mode.ToLower(), $stamp }

    # 缓存命中：同名文件尺寸已等于目标画布就直接复用，不重复压 5MB 的 PNG
    $cached = @(Get-ChildItem -LiteralPath $OutDir -File -ErrorAction SilentlyContinue |
                Where-Object { $_.BaseName -eq $baseName }) |
              Where-Object {
                  try { $ci = [System.Drawing.Image]::FromFile($_.FullName)
                        $ok = ($ci.Width -eq $box.W -and $ci.Height -eq $box.H); $ci.Dispose(); $ok } catch { $false }
              } | Select-Object -First 1

    $final = $null
    if ($cached) { $final = $cached.FullName }

    # Fill / Span 需要按目标宽高比裁剪；其余模式原图交给 Windows 处理
    $needsCrop = ($Mode -eq 'Fill' -or $Mode -eq 'Span')
    if ($null -ne $final) {
        Write-Host ("命中缓存，跳过处理: {0}" -f $final) -ForegroundColor DarkGray
    } elseif ($needsCrop) {
        # 先裁成目标宽高比，得到与 $box 同比例的 $work（像素量受源图限制）
        $work = Convert-ForFill -Src $src -Tw $box.W -Th $box.H
        try {
            # $work 与 $box 同比例，所以两边各自取 min 就是等比缩放，不会变形
            $outW = if ($AllowUpscale) { $box.W } else { [math]::Min($work.Width,  $box.W) }
            $outH = if ($AllowUpscale) { $box.H } else { [math]::Min($work.Height, $box.H) }
            if ($outW -ne $work.Width -or $outH -ne $work.Height) {
                $scaled = New-Object System.Drawing.Bitmap $outW, $outH, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
                $g = [System.Drawing.Graphics]::FromImage($scaled)
                try {
                    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                    $g.DrawImage($work, 0, 0, $outW, $outH)
                } finally { $g.Dispose() }
                $work.Dispose()
                $work = $scaled
            }
            $final = Save-Image -Img $work -Path (Join-Path $OutDir $baseName) -SrcFormatGuid $src.RawFormat.Guid
            $outW = $work.Width; $outH = $work.Height
        } finally { if ($work) { $work.Dispose() } }
        Write-Host ("目标画布 {0}x{1} -> 实际输出 {2}x{3}, {4:N0} KB" -f `
            $box.W, $box.H, $outW, $outH, ((Get-Item $final).Length / 1KB)) -ForegroundColor DarkGray
        if ($outW -lt $box.W -or $outH -lt $box.H) {
            Write-Host ("提示: 源图比屏幕原生分辨率小（{0}x{1}），已不放大避免糊；要满屏原生加 -AllowUpscale" -f $src.Width, $src.Height) -ForegroundColor Yellow
        }
        Write-Host ("输出: {0}" -f $final)
    } else {
        $final = Save-Image -Img $src -Path (Join-Path $OutDir $baseName) -SrcFormatGuid $src.RawFormat.Guid
        Write-Host ("原图直出（{0} 模式交给 Windows 缩放）" -f $Mode) -ForegroundColor DarkGray
        Write-Host ("输出: {0}" -f $final)
    }

    if ($Preview) {
        Write-Host ''
        Write-Host 'Preview 模式：只出图，没碰注册表。' -ForegroundColor Yellow
        return
    }

    $old = Save-OldState
    Write-Host ''
    Write-Host ("已记下旧壁纸（-Restore 可回退）: {0}" -f $old.Wallpaper) -ForegroundColor DarkGray

    $style = switch ($Mode) {
        'Fill'    { 10 }
        'Fit'     { 6 }
        'Stretch' { 2 }
        'Center'  { 0 }
        'Tile'    { 10 }
        'Span'    { 10 }
    }
    $tile = ($Mode -eq 'Tile' -or $Mode -eq 'Span')

    $rc = Set-DesktopWallpaper -Path $final -Style $style -Tile $tile
    Write-Host ("SystemParametersInfo rc={0}  WallpaperStyle={1}  TileWallpaper={2}" -f $rc, $style, $(if ($tile) { 1 } else { 0 })) -ForegroundColor Green

    if (-not $NoVerify) {
        Write-Host ''
        Write-Host '验证:' -ForegroundColor Cyan
        $v = Test-WallpaperApplied -Expected $final -Screens $screens
        $v.明细 | ForEach-Object {
            Write-Host ('  [{0}] {1}: {2}' -f $(if ($_.结果) { 'OK' } else { '!!' }), $_.项, $_.详情)
        }
        if (-not $v.全部通过) {
            Write-Host ''
            Write-Host '设置没完全落地。常见原因: 图片在网络盘/OneDrive 占位、或需注销重登。' -ForegroundColor Red
            exit 1
        }
    }

    if ($Mode -eq 'Span' -and @($screens).Count -gt 1) {
        Write-Host ''
        Write-Host 'Span 模式是多屏拼接的尽力而为版本。若出现重复拼接，把图按虚拟屏幕原点对齐，或改用 -Mode Fill。' -ForegroundColor Yellow
    }
} finally {
    if ($src) { $src.Dispose() }
    if ($ownedClipboard -and $tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
