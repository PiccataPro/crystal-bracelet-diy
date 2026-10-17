# 水晶手串 DIY 配置器 · 微信小程序 Demo

A zero-dependency WeChat Mini Program demo: drag beads onto a bracelet ring, get live pricing and a fit verdict. [English summary ↓](#english-summary)

一个零依赖的微信小程序演示项目：客人选珠子 → 拖进手环 → 实时看到报价与松紧判断 → 生成订单。

算法的核心不是「颗数 = 腕围 ÷ 珠径」这种把圆弧当直线的估算，而是**闭环方程数值求解**：
珠子沿圆周相切，每颗珠的圆心角由相邻两颗的半径共同决定，整环角度和必须闭合。
混搭不同珠径时这也是唯一正确的算法（等径时它精确退化为闭式公式）。

> 纯演示用途，不含任何第三方代码、不含后端。订单只落本机 storage。

---

## 功能

| 模块 | 说明 |
|---|---|
| 定制页 | 左侧珠材库（材质 × 珠径 SKU），横拖进环、环上拖动互换、拖到两颗之间插入（环会绷开） |
| 实时报价 | 按颗计价 + 绳材工费，颗数/珠径变化即时重算 |
| 松紧判定 | 用**内缘周长**对比掌围，超了转红并给出建议，不是简单比颗数 |
| 一键对称 / 一键渐变 | 只重排既有珠子，颗数、材质、珠径一颗不增不减；无法对称时明确提示，不擅自删珠 |
| 订单页 | 顾客配置固化为订单快照写入本地 storage，店主侧可查 |
| 珠径筛选 | 切换档位整批换珠子，加一颗就能看出尺寸差 |

## 快速开始

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 导入本项目目录（含 `project.config.json` 的这一层）
3. `Ctrl+B` 编译，模拟器直接可玩

**关于 AppID**：仓库里的 `appid` 是 `touristappid`（游客模式），无需任何权限即可编译和模拟器运行。

- 想真机预览/上传？把 `project.config.json` 里的 `appid` 换成**你自己**小程序账号的 AppID。
- 游客模式下「预览 / 真机调试」二维码不可用，这是微信侧限制，不是代码问题。

## 目录结构

```
app.js / app.json / app.wxss     入口与全局样式
pages/index                      首页（示例搭配入口）
pages/custom                     定制页：配珠台 + 拖拽重排 + 报价 + 下单
pages/orders                     订单管理（店主侧，本地表）
utils/bracelet-core.js           算法核心（零依赖纯函数，可单独跑 Node）
utils/order-store.js             订单构建 / 本地存取 / 推送通道占位
sitemap.json                     站点索引配置
```

## 算法要点

`utils/bracelet-core.js` 完全与 UI 解耦，纯 CommonJS，可脱离小程序在 Node 里单测。

- **`solveLoop(ds)`**：给定每颗珠径，数值求解珠心圆半径 `Rc`，使整环角度闭合。返回内缘半径 `ri`、内缘周长、每颗圆心角。
- **等径退化**：`R = d / (2·sin(π/n))`，`innerDiameter = 2R − d`。
- **`geom(d, n)` / `stretchOf(innerPerim, wrist)` / `fitVerdict(stretch)`**：等径闭式几何；拉伸率 = 掌围 / 内周长 − 1（`PALM_RATIO` 把腕围换算成掌围），并对「过松」设了下界，避免加到几百颗仍报绿。
- **`ciede2000` / `gradientPath` / `gradientEven`**：CIEDE2000 色差 + 瓶颈最短路求最平滑珠材链，再按参数轴切连续色带，实现「零修补」渐变。
- **`layout` / `hitTest` / `dropIntent` / `applyDrop`**：坐标与命中判定（含拖动插入时的环绷开动画量 `grown`）。
- **`priceOf`**：按颗计价阶梯 + 绳材工费。

分层纪律：UI 层（`pages/custom/custom.js`）**零算法**，所有数字从 core 取；手串序列存 Page 实例属性而非 `data`，避免拖动时每帧 `setData` 卡顿。

## 已知限制

- 订单推送未接后端：`utils/order-store.js` 的 `PUSH_ENDPOINT` 为空，`push()` 会**明确返回 `ok:false`**，不伪装成功。接入时只填这个常量，调用方无需改动。
- Canvas 在真机高 DPR 下的清晰度、拖拽跟手程度需真机确认，模拟器手感有差异。
- 珠材库、珠径档位、价格为演示用常量，上线应从后台/云配置下发。

## English Summary

A WeChat Mini Program demo for designing crystal bracelets. Customers pick beads, drag them onto a ring, reorder or insert between beads by dragging, and see a live price plus a wearability verdict. Orders are frozen into local `storage`.

**Why the geometry matters.** The naive formula `count = wrist ÷ beadDiameter` treats an arc as a straight line and over-prices — for a 165 mm wrist with 10 mm beads it yields 16 beads, an inner diameter of ~41 mm that a 52.5 mm palm cannot pass through. This project instead solves the closed loop numerically: beads are tangent along a circle, each bead's central angle depends on the radii of its two neighbours, and the angles must sum to exactly 2π. It stays correct when bead diameters are mixed, and degenerates exactly to `R = d / (2·sin(π/n))`, `innerDiameter = 2R − d` for the uniform case.

**Features**

- Bead palette of material × diameter SKUs; drag into the ring, swap by dragging one bead onto another, insert between two beads (the ring visibly stretches open).
- Live pricing (per-bead ladder + cord fee) and fit verdict based on **inner circumference** vs palm circumference — not a bead count.
- One-tap symmetry and gradient: reorder only, never add or drop a bead; refuses with a clear message when symmetry is impossible.
- Gradient uses CIEDE2000 colour distance plus a bottleneck-shortest-path bead chain, then slices continuous colour bands — zero post-hoc patching.
- Orders page persists a snapshot to local `storage`; `push()` is a deliberate stub returning `ok:false` rather than faking success.

**Quick start**

1. Install WeChat DevTools (Windows/macOS).
2. Import this repository root — the folder containing `project.config.json`.
3. Press `Ctrl+B` / `Cmd+B` to compile; the simulator is immediately interactive.

`appid` is `touristappid` (guest mode) so no account permission is needed. Guest mode cannot produce a real-device preview QR code — that is a WeChat-side restriction. Replace `appid` with your own Mini Program AppID if you want preview or upload.

**Layout**

```
app.js / app.json / app.wxss     entry and global styles
pages/index                      home (preset entry points)
pages/custom                     configurator: palette, drag, pricing, order
pages/orders                     order list (owner side, local table)
utils/bracelet-core.js           geometry, colour, pricing — pure CommonJS, zero deps
utils/order-store.js             order snapshot, storage, push stub
```

`utils/bracelet-core.js` has no Mini Program dependency at all and can be unit-tested under plain Node. The UI layer deliberately contains **zero algorithm**; the bead sequence lives on the `Page` instance rather than in `data` to avoid per-frame `setData` serialisation during drags.

**Known limitations**

- No backend. `PUSH_ENDPOINT` in `utils/order-store.js` is empty, so `push()` returns `ok:false`; orders stay local.
- Canvas sharpness on high-DPR devices and real-device drag feel were never verified on hardware.
- Bead library, size tiers and prices are demo constants; production should serve them from a backend or cloud config.

**License** — [MIT](LICENSE) © 2026 PiccataPro

---

## 许可


[MIT](LICENSE) © 2026 PiccataPro
