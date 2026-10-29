# rdd-harness — AI 自主实验轮回的工程脚手架

> 一句话：给「AI 在 Minecraft 里自主干活」配一套**可验证、可回退、可复算**的工程底座——
> 门禁（进/退游戏前后）、实验卡（事前冻结判据+原始数据机械复算）、无人值守学习轮回（exp-cycle）、
> 观测器（标准开源 Mineflayer）。AI 自己写、自己验；人只定总目标、最后看一眼。

## 这是什么

| 部件 | 作用 | 入口 |
|---|---|---|
| `registry.json` | 单一真源：98 工具、40 门禁（preflight 21 / postflight 19）、10 条根路径、17 条时间锁 | `bin/harness-gate.js registry` |
| 门禁 | 进游戏前 `preflight` / 退游戏后 `postflight`；`selftest` 自检接线 | `bin/harness-gate.js selftest` |
| 实验卡 | 可证伪主张 + 成功/失败双阈值 + 正负对照 + 冻结 hash + 原始数据复算 | `bin/exp-card.js new/validate/freeze/conclude` |
| 运行器 | 复制母版世界 → 起停游戏 → 派活 → 观测 → 受控复位 → 归档 | `bin/exp-runner.js run --label x --minutes N` |
| 裁判 | 只读证据出裁决，不认口头结论（离线自测 5/5 拒三种假绿） | `bin/exp-judge.js <runDir>` |
| 轮回 | 连跑 N 轮、轮末简报带进下一轮、机械判定 improved | `bin/exp-cycle.js run --prefix learn --rounds 4` |
| 观测器 | 标准开源 mineflayer@4.39.0（无 fork）；`eval <file.js>` 让 AI 用代码玩游戏 | `bin/mf-observer.js smoke/eval` |

## 快速开始（三分钟自证）

```powershell
node bin/harness-gate.js selftest   # 门禁接线全 ✔（FAIL=0）
node bin/exp-card.js selftest       # 12/12（判据矛盾/无种子/缺理由/样本不足/改卡/claim 矛盾 必拒）
node bin/exp-judge.js --selftest    # 5/5（加载错/缺裁剪/只回成功无产物 必拒）
```

这三条不碰游戏、不需要任何 API key——先证明「裁判不撒谎」，再谈跑实验。

## 跑一次真实轮回（需要 Minecraft 实例）

```powershell
node bin/exp-card.js new exp-demo --title "两轮独立冒烟都通过"
# 编辑 experiments/cards/exp-demo.json：claim / 阈值 / 对照 / 数据源
node bin/exp-card.js validate experiments/cards/exp-demo.json
node bin/exp-card.js freeze experiments/cards/exp-demo.json --commit <git sha> --apply
node bin/exp-cycle.js run --prefix demo --rounds 4 --minutes 25 --zero-start --goal-file <开场任务.txt>
node bin/exp-card.js conclude experiments/cards/exp-demo.json
```

**铁律**：判据先冻结再跑；结论只从原始数据复算；样本不足/缺字段 → INCONCLUSIVE（不制造显著性）；
冻结后改卡 → 拒绝出结论；口头 claim 与数据矛盾 → 数据赢。

## 部署到新机器

看 `package/README-自动harness包-20261027.md` + `package/74-新机安装与迁移指南-20261019.md`
（618 行实测迁移记录：0–8 阶段顺序、约 40 条坑的症状→根因→修法、验收清单）。

## 诚实的边界

- 本仓只是「脚手架」：Minecraft 实例、mods、存档、JDK/Gradle/Node、模型 API 都不在仓里，按部署文档自建。
- `multimodel/` 是多模型适配层（OpenRouter 免费表只含定价信息，无 key）；任何密钥都不入库。
- 门禁里的路径真源在 `registry.json` 的 `roots`，换机改那 10 条即可。
- 实验结论的样本量都很小（pilot），只能看方向；我们不夸大「越玩越聪明」。

## License

MIT。用的时候请保留「判据先冻结、数据赢」这两条精神——那是这套东西唯一不可让步的部分。
