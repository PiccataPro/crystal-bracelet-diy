# 水晶手串 DIY 配置器 · 微信小程序 Demo

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

- **`solveLoop(ds)`**：给定每颗珠径，数值求解珠心圆半径 `Rc`，使整环角度闭合。返回内径 `ri`、内缘周长、每颗圆心角。
- **等径退化**：`R = d / (2·sin(π/n))`，`innerDiameter = 2R − d`。
- **`geom` / `fitVerdict`**：内缘周长 vs 掌围（`PALM_RATIO` 换算），给出松紧档位与建议。
- **`ciede2000` / `gradientPath` / `gradientEven`**：CIEDE2000 色差 + 瓶颈最短路求最平滑珠材链，再按参数轴切连续色带，实现「零修补」渐变。
- **`layout` / `hitTest` / `dropIntent` / `applyDrop`**：坐标与命中判定（含拖动插入时的环绷开动画量 `grown`）。
- **`priceOf`**：按颗计价阶梯 + 绳材工费。

分层纪律：UI 层（`pages/custom/custom.js`）**零算法**，所有数字从 core 取；手串序列存 Page 实例属性而非 `data`，避免拖动时每帧 `setData` 卡顿。

## 已知限制

- 订单推送未接后端：`utils/order-store.js` 的 `PUSH_ENDPOINT` 为空，`push()` 会**明确返回 `ok:false`**，不伪装成功。接入时只填这个常量，调用方无需改动。
- Canvas 在真机高 DPR 下的清晰度、拖拽跟手程度需真机确认，模拟器手感有差异。
- 珠材库、珠径档位、价格为演示用常量，上线应从后台/云配置下发。

## 许可

[MIT](LICENSE) © 2026 PiccataPro
