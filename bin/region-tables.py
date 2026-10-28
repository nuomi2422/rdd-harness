#!/usr/bin/env python3
"""region-tables.py —— Minecraft 存档 region 的方块级盘点/替换（离线，不依赖游戏）

为什么存在：
  学习线 A/B 需要「同一份固定地形、且没有工作台」的母版。工作台常常是世界生成的
  （village_savanna 的房子里就有），空母版每次重算都会把它长回来 —— 只能烘出区块后
  离线把 palette 里的方块名改掉。这个脚本就是那一步，可复核、可重跑。

用法：
  python region-tables.py check <worldDir> [--block minecraft:crafting_table]
  python region-tables.py strip <worldDir> [--block minecraft:crafting_table] [--to minecraft:air]

输出：一行 JSON（chunks / block 命中数 / 命中 chunk 索引）。
纪律：
  - 只改 region/*.mca；不动 level.dat / playerdata / entities。
  - strip 前先备份整个存档目录（脚本不替你备份）。
  - 只替换「NBT 字符串 长度前缀 + 名字」整串，不会误伤别处的同名子串。
  - 重写 region 后逐块解 NBT 校验（check 会做），900/900 可解析才算过。
"""
import json
import os
import struct
import sys
import zlib
import gzip

SECTOR = 4096


def parse_region(path):
    """返回 {chunkIndex: (compression, payload, timestamp)}；损坏/空文件返回 {}。"""
    data = open(path, 'rb').read()
    if len(data) < 2 * SECTOR:
        return {}
    chunks = {}
    for i in range(1024):
        off = struct.unpack_from('>I', data, i * 4)[0]
        if off == 0:
            continue
        start = (off >> 8) * SECTOR
        if start + 5 > len(data):
            continue
        ln = struct.unpack_from('>I', data, start)[0]
        comp = data[start + 4]
        chunks[i] = (comp, data[start + 5:start + 4 + ln], struct.unpack_from('>I', data, SECTOR + i * 4)[0])
    return chunks


def decomp(comp, payload):
    if comp == 1:
        return gzip.decompress(payload)
    if comp == 2:
        return zlib.decompress(payload)
    if comp == 3:
        return payload
    raise ValueError('unsupported compression %d' % comp)


def write_region(path, chunks):
    header = bytearray(SECTOR * 2)
    body = bytearray()
    cur = 2
    for i in sorted(chunks):
        nbt, ts = chunks[i]
        payload = zlib.compress(nbt, 6)
        ln = len(payload) + 1
        sectors = (4 + ln + SECTOR - 1) // SECTOR
        struct.pack_into('>I', header, i * 4, (cur << 8) | sectors)
        struct.pack_into('>I', header, SECTOR + i * 4, ts)
        rec = struct.pack('>I', ln) + b'\x02' + payload
        rec += b'\x00' * (sectors * SECTOR - len(rec))
        body += rec
        cur += sectors
    open(path, 'wb').write(bytes(header) + bytes(body))


def patterns(block, to):
    # NBT 字符串 = 2 字节大端长度 + UTF-8；整串匹配，避免误伤子串
    from_pat = struct.pack('>H', len(block.encode())) + block.encode()
    to_pat = struct.pack('>H', len(to.encode())) + to.encode()
    return from_pat, to_pat


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    mode, world = sys.argv[1], sys.argv[2]
    block = 'minecraft:crafting_table'
    to = 'minecraft:air'
    if '--block' in sys.argv:
        block = sys.argv[sys.argv.index('--block') + 1]
    if '--to' in sys.argv:
        to = sys.argv[sys.argv.index('--to') + 1]
    from_pat, to_pat = patterns(block, to)

    reg = os.path.join(world, 'region')
    if not os.path.isdir(reg):
        print(json.dumps({'ok': False, 'reason': 'no region dir: ' + reg}, ensure_ascii=False))
        return 3

    chunks_total = hits = 0
    files = []
    for f in sorted(os.listdir(reg)):
        if not f.endswith('.mca'):
            continue
        p = os.path.join(reg, f)
        if os.path.getsize(p) == 0:
            continue
        chunks = parse_region(p)
        chunks_total += len(chunks)
        out = {}
        file_hits = 0
        hit_idx = []
        for i, (comp, payload, ts) in chunks.items():
            nbt = decomp(comp, payload)
            n = nbt.count(from_pat)
            if n:
                file_hits += n
                hit_idx.append(i)
                if mode == 'strip':
                    nbt = nbt.replace(from_pat, to_pat)
            out[i] = (nbt, ts)
        if mode == 'strip' and file_hits:
            write_region(p, out)
        hits += file_hits
        files.append({'file': f, 'chunks': len(chunks), 'hits': file_hits, 'chunks_with_hits': hit_idx})

    print(json.dumps({'ok': True, 'mode': mode, 'world': world, 'block': block,
                      'chunks': chunks_total, 'hits': hits, 'files': files}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
