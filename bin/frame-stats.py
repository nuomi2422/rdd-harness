# -*- coding: utf-8 -*-
"""frame-stats.py —— 逐帧"信息量"统计（离线，只读）
为什么存在（2026-11-09）：曾用 PNG 文件体积当"纹理度"，结果一张 392KB 的水面帧
被误判成高信息画面。体积只是压缩率，不是信息量。这里直接算像素统计：
  std   = 灰度标准差（画面是否均匀）
  edge  = 相邻像素差的平均绝对值（有无结构/边缘）
  uniq  = 量化色阶数（近似颜色丰富度）
用法：python frame-stats.py <take目录> [--limit N]
输出：take目录\frame-stats.csv  (name,std,edge,uniq)
低信息判据（建议）：std < 6 且 edge < 2  → 视为低信息画面（天空/水面/虚空/贴墙）
"""
import sys, os, csv
try:
    from PIL import Image
except Exception as e:
    print('缺少 Pillow: %s' % e); sys.exit(2)

def stats(path):
    im = Image.open(path).convert('L')
    # 缩小再算，够判别且更快；不影响"均匀 vs 有结构"的区分
    im = im.resize((128, 72), Image.BILINEAR)
    px = list(im.getdata())
    n = len(px)
    mean = sum(px) / n
    var = sum((p - mean) ** 2 for p in px) / n
    std = var ** 0.5
    w, h = im.size
    edge = 0.0; cnt = 0
    for y in range(h):
        row = px[y * w:(y + 1) * w]
        for x in range(1, w):
            edge += abs(row[x] - row[x - 1]); cnt += 1
    edge = edge / cnt if cnt else 0.0
    uniq = len(set((p // 16) for p in px))
    return round(std, 3), round(edge, 3), uniq

def main():
    if len(sys.argv) < 2:
        print('用法: python frame-stats.py <take目录> [--limit N]'); sys.exit(2)
    d = sys.argv[1]
    limit = None
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])
    files = sorted(f for f in os.listdir(d) if f.startswith('f_') and f.lower().endswith('.png'))
    if limit: files = files[:limit]
    out = os.path.join(d, 'frame-stats.csv')
    rows = []
    for f in files:
        s, e, u = stats(os.path.join(d, f))
        rows.append((f, s, e, u))
    with open(out, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh); w.writerow(['name', 'std', 'edge', 'uniq']); w.writerows(rows)
    low = [r for r in rows if r[1] < 6 and r[2] < 2]
    print('帧数=%d 低信息帧=%d (%.1f%%) -> %s' % (len(rows), len(low), 100.0 * len(low) / max(1, len(rows)), out))

main();
