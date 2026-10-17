/* core.js — 水晶手串配置器核心算法（零依赖，纯函数）
 *
 * 与 UI 解耦，可直接被微信小程序端引用（同为 CommonJS）。
 * 本文件是 prototype/index.html 的算法单一事实来源——
 * 原型里的函数由此注入，不要在两处各写一份。
 *
 * ⚠️ 重要：v3 起支持「混搭珠径」。此前"腕围÷珠径=颗数"的闭式公式仅在等径时成立，
 *    混搭后必须用闭环方程数值求解 solveLoop()。等径时它精确退化为旧公式。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BraceletCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ========= 珠材库 ========= */
  const BEADS = [
    { id:'w',  name:'白水晶', lab:[95,  0, -2], hex:'#F2F0EC', price:20 },
    { id:'pk', name:'草莓晶', lab:[78, 18,-18], hex:'#F0B8C4', price:20 },
    { id:'ro', name:'粉晶',   lab:[70, 25,-15], hex:'#E8A9B8', price:20 },
    { id:'am', name:'紫水晶', lab:[45, 25,-25], hex:'#8B6FA8', price:20 },
    { id:'te', name:'茶晶',   lab:[55, 10, 22], hex:'#8B6B4A', price:20 },
    { id:'ye', name:'黄水晶', lab:[80, 12, 55], hex:'#E0B84E', price:20 },
    { id:'ls', name:'青金石', lab:[29,-13,-47], hex:'#2B4C8C', price:20 },
    { id:'nv', name:'藏青',   lab:[20,  2,-45], hex:'#1F2A5E', price:20 },
    { id:'gr', name:'绿幽灵', lab:[60,-25, 15], hex:'#7EB88A', price:20 },
    { id:'rd', name:'红玛瑙', lab:[50, 32, 22], hex:'#B0483C', price:20 },
    { id:'bk', name:'黑曜石', lab:[18,  0,  0], hex:'#3A3A3A', price:20 },
    { id:'pe', name:'珍珠',   lab:[92,  4,  6], hex:'#F0EAE4', price:20 },
  ];
  const MAP = Object.fromEntries(BEADS.map(b => [b.id, b]));

  /* 混搭定价：同一种水晶，大珠用料更多。
   * 近似用体积缩放 d^3 会让价差过大（12→14 涨 59%），
   * 实际水晶行业按"规格跳档"定价，故用线性跳档表，可后台配置。 */
  const PRICE_LADDER = { 8:14, 10:17, 12:20, 14:26 };
  function priceOf(id, d) {
    if (PRICE_LADDER[d]) return PRICE_LADDER[d];
    const b = MAP[id];
    if (!b) return 20;
    // 非标准档位按最接近档位线性外插
    const ks = Object.keys(PRICE_LADDER).map(Number).sort((x, y) => x - y);
    if (d <= ks[0]) return PRICE_LADDER[ks[0]];
    if (d >= ks[ks.length - 1]) return PRICE_LADDER[ks[ks.length - 1]];
    for (let i = 0; i < ks.length - 1; i++) {
      if (d >= ks[i] && d <= ks[i + 1]) {
        const t = (d - ks[i]) / (ks[i + 1] - ks[i]);
        return Math.round(PRICE_LADDER[ks[i]] + (PRICE_LADDER[ks[i + 1]] - PRICE_LADDER[ks[i]]) * t);
      }
    }
    return b.price;
  }

  const PALM_RATIO = 1.20;   // 掌围 / 腕围，经验值
  const CORD_FEE  = { elastic:2, wax:5 };

  /* ======================================================================
   * 算法 1：尺寸换算 v3 —— 混合珠径闭环求解
   *
   * 问题：v2 的 n = π / arcsin(1/(L/(π·d)+1)) 依赖"所有珠径相同"。
   * 一旦混搭（如 12mm 与 14mm 交替），相邻珠心弦长 = (d_i+d_j)/2 ≠ d，
   * 闭式解失效。
   *
   * 正确模型：珠子沿半径 Rc 的圆周排布，相邻珠心弦长
   *     chord_i = (d_i + d_{i+1}) / 2
   * 弦对应的圆心角
   *     θ_i = 2·arcsin( chord_i / (2·Rc) )
   * 闭合条件（绕满一整圈）
   *     Σ θ_i = 2π
   * 该式对 Rc 单调（Rc 越大 Σθ 越小），故可用二分法求解。
   *
   * 退化验证：等径 d、n 颗时 Σθ = n·2·arcsin(d/(2Rc)) = 2π
   *   ⟹ arcsin(d/(2Rc)) = π/n ⟹ Rc = d / (2·sin(π/n))
   * 正是 v2 的闭式解。实测二者的差 < 1e-13 mm。
   * ==================================================================== */
  function slotAngles(ds, Rc) {
    const n = ds.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const chord = (ds[i] + ds[(i + 1) % n]) / 2;
      const r = chord / (2 * Rc);
      if (r > 1) return null;              // 弦长超过直径，几何上排不下
      out[i] = 2 * Math.asin(r);
    }
    return out;
  }
  function sumAngles(ds, Rc) {
    const th = slotAngles(ds, Rc);
    if (!th) return Infinity;
    let s = 0;
    for (let i = 0; i < th.length; i++) s += th[i];
    return s;
  }
  /** 闭环求解：给定每颗珠径，返回 Rc 与派生量
   *
   *  ⚠️ 只要 n >= 3，闭环解必然存在，不存在"排不下"的情况：
   *     Rc -> dmax/2 时每个 θ_i -> π，Σθ -> n·π >= 3π > 2π
   *     Rc -> ∞     时 Σθ -> 0 < 2π
   *     Σθ 对 Rc 连续单调，故必有唯一解。
   *  所以「太紧/太松」不能作为 solveLoop 的失败原因——
   *  那是**佩戴状态**问题，应由 stretchOf() + fitVerdict() 判定。
   *  举例：3 颗 14mm 闭环解出内径仅 2.2mm，几何上成立但显然戴不上手；
   *  正确报错位置是 fitVerdict →「过掌拉伸 2800%，应加珠」，
   *  而不是在 solveLoop 里粗暴返回 tooTight。
   */
  function solveLoop(ds) {
    const n = ds.length;
    if (n < 3) return { ok:false, reason:'tooFew', n };
    const dmax = Math.max.apply(null, ds);
    let lo = dmax / 2 * 1.0000001;
    let hi = dmax * 200 + 1000;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (sumAngles(ds, mid) > 2 * Math.PI) lo = mid; else hi = mid;
    }
    const Rc = (lo + hi) / 2;
    const th = slotAngles(ds, Rc);
    const chordSum = ds.reduce((s, d, i) => s + (d + ds[(i + 1) % n]) / 2, 0);
    const ri = Rc - dmax / 2;
    return {
      ok: true, n, Rc, th, ri,
      chordSum,                                        // 珠心弦长总和 = 线下料基准
      innerPerim: 2 * Math.PI * ri,                    // 内缘周长
      avgD: chordSum / n,                              // 平均珠径（等效）
      mixed: ds.some(d => d !== ds[0]),
    };
  }
  /** 等径快捷路径：v2 闭式解（保留以便对拍与优化） */
  function slotsFor(wristMm, dMm, easeMm) {
    const L = wristMm + easeMm;
    const s = 1 / (L / (Math.PI * dMm) + 1);
    return Math.floor(Math.PI / Math.asin(s));
  }
  function geom(dMm, n) {
    const Rc = dMm / (2 * Math.sin(Math.PI / n));
    return { Rc, ri: Rc - dMm / 2, Li: 2 * Math.PI * (Rc - dMm / 2),
             cord: Math.PI * dMm / Math.sin(Math.PI / n) };
  }
  /** 建议颗数：按目标周长与平均珠径反推（混搭时用平均径） */
  function suggestCount(targetPerim, dMm) {
    let lo = 3, hi = 200;
    while (hi > lo && (function () {
      const n = hi, Rc = dMm / (2 * Math.sin(Math.PI / n));
      return 2 * Math.PI * (Rc - dMm / 2) > targetPerim;
    })()) hi--;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const Rc = dMm / (2 * Math.sin(Math.PI / mid));
      if (2 * Math.PI * (Rc - dMm / 2) <= targetPerim) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  /** 过掌拉伸率 */
  function stretchOf(innerPerim, wristMm) {
    return (wristMm * PALM_RATIO / innerPerim - 1) * 100;
  }
  /* 佩戴判定的松侧阈值 —— 松侧**必须有下界**。
   *
   * ⚠️ 旧实现只在 stretch < 8 报 warn，之后没有任何下限，于是
   *    「加珠子 → 环变大 → 越来越松」这条路走到尽头也不报警：
   *    实测 12mm 加到 200 颗，内缘周长 2756mm（比腰围还粗）仍是黄色。
   *
   * 红线的物理含义（stretch = 掌围 / 内周长 - 1）：
   *    stretch > 0  → 内周长小于掌围，要撑开才套得进，正常
   *    stretch = 0  → 内周长恰好等于掌围，不用费力就能套过
   *    stretch < 0  → 内周长**大于**掌围，套过手掌完全不需要拉伸，
   *                   戴在腕上必然松垮滑脱 —— 结构性缺陷，报 bad
   *
   * 蜡绳（活结）的松侧红线放到 -10：活结能现场收紧约 10mm，
   * 对应富余 ~5%，再松就收不回来了。比弹力线的 0 宽容，但不是无限。
   */
  const LOOSE_BAD = { elastic: 0, wax: -10 };
  function fitVerdict(stretch, cordType) {
    const lb = LOOSE_BAD[cordType] !== undefined ? LOOSE_BAD[cordType] : 0;
    if (cordType === 'elastic') {
      if (stretch > 45) return { level:'bad',  msg:'过掌拉伸 ' + stretch.toFixed(0) + '%，弹力线受力过大易断，应加珠' };
      if (stretch > 35) return { level:'warn', msg:'过掌拉伸 ' + stretch.toFixed(0) + '%，偏紧，弹力线寿命会缩短' };
      if (stretch < lb) return { level:'bad',  msg:'内缘周长已超过掌围 ' + (-stretch).toFixed(0) + '%，套过手掌无需拉伸，上手会滑脱，应减珠或换小珠' };
      if (stretch < 8)  return { level:'warn', msg:'仅需拉伸 ' + stretch.toFixed(0) + '%，偏松，上手会晃' };
      return { level:'ok', msg:'过掌拉伸 ' + stretch.toFixed(0) + '%，在健康区间 8%–35%' };
    }
    if (stretch > 45) return { level:'bad',  msg:'闭合周长超出掌围 ' + stretch.toFixed(0) + '%，过不去' };
    if (stretch < lb) return { level:'bad',  msg:'闭合周长超掌围 ' + (-stretch).toFixed(0) + '%，活结已收不回，应减珠或换小珠' };
    if (stretch < 8)  return { level:'warn', msg:'闭合周长远大于掌围 ' + stretch.toFixed(0) + '%，会松脱' };
    return { level:'ok', msg:'闭合周长与掌围匹配（富余 ' + stretch.toFixed(0) + '%）' };
  }
  /**
   * 可执行建议：把「拉伸率是否健康」翻译成一个动作结论。
   *
   * 拉伸率偏大 = 手串内缘周长偏小 = 戴不进去 → 要么**加珠**（颗数多则环大），
   *   要么**换大珠**（单颗大则环大）。
   * 拉伸率偏小 = 内缘周长偏大 = 上手会晃 → 要么**减珠**，要么**换小珠**。
   * 两者如何取舍：看颗数与建议颗数（suggestCount 的闭合解）的关系 ——
   *   颗数还没到位就先调颗数，颗数已经到位就只能动珠径。
   *
   * ⚠️ 只在 UI 层做文案映射（'add' → 「建议增加珠子」），core 只吐语义码，
   *    以保证同一套判定在原型/小程序/将来的后台都能复用。
   *
   * @returns {'ok'|'add'|'cut'|'smaller'|'bigger'}
   */
  function fitAdvice(stretch, n, sugN, cordType) {
    const hi = fitBand(cordType).hi;
    if (stretch > hi) return n < sugN ? 'add' : 'bigger';
    if (stretch < 8)  return n > sugN ? 'cut' : 'smaller';
    return 'ok';
  }
  /** 健康带 —— 唯一真源。fitVerdict / fitAdvice / resizeAdvice 都从这里取，禁止另写一份。 */
  function fitBand(cordType) {
    return cordType === 'elastic' ? { lo:8, hi:35 } : { lo:8, hi:45 };
  }
  /** 保持颗数 n 不变、把珠径改成 d 之后的过掌拉伸率；n<3 无环可解，返回 null */
  function stretchAtCount(n, d, wristMm) {
    if (!(n >= 3) || !(d > 0)) return null;
    const g = solveLoop(new Array(n).fill(d));
    return g.ok ? stretchOf(g.innerPerim, wristMm) : null;
  }
  /**
   * 「不动颗数」时的换径备选 —— 主建议之外的**副建议**。
   *
   * ⚠️ 为什么它只能是副的：主建议（add/cut）走的是「改颗数」这条路，
   *    每改一颗只挪 4~15 个百分点的拉伸率；换一档珠径要挪 24~45 个百分点。
   *    两条路的粒度差一个数量级 —— 只要颗数自由，动颗数永远是更细的螺丝刀。
   *    换径只在**顾客想守住颗数**时才有意义，所以并列给出去让顾客自己选，
   *    而不是靠 n 与 sugN 的大小关系二选一
   *    （那两个条件数学上不可同时成立，旧实现的 bigger/smaller 从未被触发过）。
   *
   * 方向与主建议一致：偏松（拉伸率低）往**小珠**找，偏紧往**大珠**找。
   * 在 sizes 里取「颗数不变就能落进健康带」且离 curD 最近的那一档；
   * 一档都落不进（例：40 颗就算换成 8mm 也太松）→ 返回 null，不硬凑建议。
   */
  function resizeAdvice(n, wristMm, cordType, curD, sizes) {
    const B = fitBand(cordType);
    const cand = (sizes || [])
      .filter(d => Math.abs(d - curD) > 1e-9)
      .sort((a, b) => Math.abs(a - curD) - Math.abs(b - curD));
    for (let i = 0; i < cand.length; i++) {
      const d = cand[i];
      const s = stretchAtCount(n, d, wristMm);
      if (s !== null && s >= B.lo && s <= B.hi) {
        return { d: d, stretch: s, dir: d > curD ? 'bigger' : 'smaller' };
      }
    }
    return null;
  }

  /* ======================================================================
   * 算法 2：CIEDE2000
   * ==================================================================== */
  const d2r = d => d * Math.PI / 180, r2d = r => r * 180 / Math.PI;
  function ciede2000(Lab1, Lab2) {
    const L1 = Lab1[0], a1 = Lab1[1], b1 = Lab1[2];
    const L2 = Lab2[0], a2 = Lab2[1], b2 = Lab2[2];
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
    const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
    const hp = (b, ap) => { let h = (b === 0 && ap === 0) ? 0 : r2d(Math.atan2(b, ap)); return h < 0 ? h + 360 : h; };
    const hp1 = hp(b1, ap1), hp2 = hp(b2, ap2);
    const dLp = L2 - L1, dCp = Cp2 - Cp1;
    let dhp = 0;
    if (Cp1 * Cp2 !== 0) { dhp = hp2 - hp1; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
    const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(d2r(dhp / 2));
    const Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2;
    let hpb = hp1 + hp2;
    if (Cp1 * Cp2 !== 0) {
      const df = Math.abs(hp1 - hp2);
      if (df <= 180) hpb = (hp1 + hp2) / 2;
      else if (hp1 + hp2 < 360) hpb = (hp1 + hp2 + 360) / 2;
      else hpb = (hp1 + hp2 - 360) / 2;
    }
    const T = 1 - 0.17 * Math.cos(d2r(hpb - 30)) + 0.24 * Math.cos(d2r(2 * hpb))
            + 0.32 * Math.cos(d2r(3 * hpb + 6)) - 0.20 * Math.cos(d2r(4 * hpb - 63));
    const dT = 30 * Math.exp(-Math.pow((hpb - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(Cpb, 7) / (Math.pow(Cpb, 7) + Math.pow(25, 7)));
    const Sl = 1 + 0.015 * Math.pow(Lb - 50, 2) / Math.sqrt(20 + Math.pow(Lb - 50, 2));
    const Sc = 1 + 0.045 * Cpb, Sh = 1 + 0.015 * Cpb * T;
    const Rt = -Math.sin(d2r(2 * dT)) * Rc;
    return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) +
                     Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
  }
  function nearest(lab) {
    let best = BEADS[0], bv = 1e9;
    for (const b of BEADS) { const d = ciede2000(lab, b.lab); if (d < bv) { bv = d; best = b; } }
    return best;
  }

  /* ======================================================================
   * 算法 3：渐变排布 —— 瓶颈最短路 + 连续色带
   *
   * 三次尝试后定案：
   *   v1 LAB 插值 → 退化 3 色；v2 色相主轴+同色错开 → 全退化白水晶且色序交错。
   * 根因是"每槽独立选色"必然同色堆叠，事后修补又破坏单调性。
   * v3 两阶段且零修补：先求最平滑珠材链，再按参数轴切连续色带。
   * ==================================================================== */
  function projAxis(A, B) {
    const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    return t => dd === 0 ? 0
      : ((t[0] - A[0]) * d[0] + (t[1] - A[1]) * d[1] + (t[2] - A[2]) * d[2]) / dd;
  }
  function gradientPath(aId, bId) {
    const A = MAP[aId].lab, B = MAP[bId].lab, pr = projAxis(A, B);
    const cand = BEADS.map(b => ({ id:b.id, lab:b.lab, t:pr(b.lab) }))
      .filter(c => c.t >= -0.15 && c.t <= 1.15).sort((x, y) => x.t - y.t);
    const ia = cand.findIndex(c => c.id === aId), ib = cand.findIndex(c => c.id === bId);
    if (ia < 0 || ib < 0) return [aId, bId];
    const chain = [cand[ia],
      ...cand.filter(c => c.t > cand[ia].t + 1e-9 && c.t < cand[ib].t - 1e-9 &&
                          c.id !== aId && c.id !== bId),
      cand[ib]];
    const m = chain.length;
    const best = Array.from({ length:m }, () => ({ mx:Infinity, sum:0, prev:-1 }));
    best[0] = { mx:0, sum:0, prev:-1 };
    for (let j = 1; j < m; j++) for (let i = 0; i < j; i++) {
      const step = ciede2000(chain[i].lab, chain[j].lab);
      const mx = Math.max(best[i].mx, step), sum = best[i].sum + step;
      if (mx < best[j].mx - 1e-9 ||
          (Math.abs(mx - best[j].mx) < 1e-9 && sum < best[j].sum - 1e-9))
        best[j] = { mx, sum, prev:i };
    }
    const path = []; let k = m - 1;
    while (k >= 0) { path.push(chain[k].id); if (best[k].prev < 0) break; k = best[k].prev; }
    return path.reverse();
  }
  function gradientEven(aId, bId, n) {
    if (!n || n < 1) return [];
    let path = gradientPath(aId, bId);
    while (path.length > n && path.length > 2) {
      let worst = 1, wv = Infinity;
      for (let j = 1; j < path.length - 1; j++) {
        const v = ciede2000(MAP[path[j - 1]].lab, MAP[path[j + 1]].lab);
        if (v < wv) { wv = v; worst = j; }
      }
      path.splice(worst, 1);
    }
    const m = path.length;
    if (m === 1) return Array(n).fill(aId);
    const pr = projAxis(MAP[aId].lab, MAP[bId].lab);
    const ts = path.map(id => pr(MAP[id].lab));
    const edge = [0];
    for (let j = 1; j < m; j++) edge.push((ts[j - 1] + ts[j]) / 2);
    edge.push(1);
    const w = edge.slice(1).map((v, j) => Math.max(1e-6, v - edge[j]));
    const cnt = w.map(x => Math.floor(x * n));
    let rem = n - cnt.reduce((s, x) => s + x, 0);
    const ord = w.map((x, j) => ({ j, frac:x * n - Math.floor(x * n) })).sort((p, q) => q.frac - p.frac);
    for (let k = 0; k < rem; k++) cnt[ord[k % ord.length].j]++;
    for (let j = 0; j < m; j++) if (cnt[j] === 0) {
      let k = -1;
      for (let q = 0; q < m; q++) if (cnt[q] > 1 && (k < 0 || cnt[q] > cnt[k])) k = q;
      if (k < 0) break;
      cnt[k]--; cnt[j]++;
    }
    const out = [];
    for (let j = 0; j < m; j++) for (let k = 0; k < cnt[j]; k++) out.push(path[j]);
    while (out.length < n) out.push(path[m - 1]);
    out.length = n;
    return out;
  }

  /* ======================================================================
   * 算法 4：Burnside 归一化（配色去重）
   * 判定口径为 bracelet（旋转 + 翻转等价），因为用户看到的是同一个环。
   * 珠径也参与身份：同色不同径不算同款。
   * ==================================================================== */
  function canonKey(seq) {
    const keys = seq.map(b => b.d ? b.id + '@' + b.d : b.id);
    const n = keys.length;
    if (n < 2) return keys.join(',');
    let best = null;
    const rot = s => s.slice(1).concat(s[0]);
    for (const cand of [keys, keys.slice().reverse()]) {
      let s = cand.slice();
      for (let k = 0; k < n; k++) {
        if (!best || s.join() < best.join()) best = s;
        s = rot(s);
      }
    }
    return best.join(',');
  }

  /* ======================================================================
   * 序列操作：槽位模型已改为「已放置序列」，无空位
   * ==================================================================== */
  const seqDs = seq => seq.map(b => b.d);
  function addOne(seq, id, d) { return seq.concat([{ id, d }]); }
  /** 在索引 i 处插入一颗 —— 拖到环上某处松手时用，i 会被夹到 [0, n]
   *
   *  ⚠️ 与 addOne 的区别不是「少写一行」：addOne 只能追加到**末尾**，
   *     而顾客拖到环上第 3 颗旁边时，珠子应当出现在第 3 颗旁边。
   *     用末尾追加会让「落点」与「实际位置」脱节，看起来就是"放到别处去了"。 */
  function insertAt(seq, i, id, d) {
    const s = seq.slice();
    const t = Math.max(0, Math.min(s.length, i));
    s.splice(t, 0, { id, d });
    return s;
  }
  function replaceAt(seq, i, id, d) {
    const s = seq.slice();
    if (i >= 0 && i < s.length) s[i] = { id, d: d || s[i].d };
    return s;
  }
  function removeAt(seq, i) {
    if (i < 0 || i >= seq.length) return seq;
    return seq.slice(0, i).concat(seq.slice(i + 1));
  }
  function moveItem(seq, from, to) {
    if (from === to || from < 0 || from >= seq.length) return seq;
    const s = seq.slice();
    const t = Math.max(0, Math.min(s.length - 1, to));
    s.splice(t, 0, s.splice(from, 1)[0]);
    return s;
  }
  function swapItems(seq, i, j) {
    if (i === j || i < 0 || j < 0 || i >= seq.length || j >= seq.length) return seq;
    const s = seq.slice(), t = s[i]; s[i] = s[j]; s[j] = t;
    return s;
  }
  /** 一键对称：取前半（含中位）镜像成后半 */
  /** 一键对称：把**现有的珠子**重排成镜像（回文）—— 不增颗、不换材质。
   *
   *  ⚠️ 旧实现是「取前半镜像**覆盖**后半」：白 草莓 茶 青金 红 → 白 草莓 茶 草莓 白，
   *     后半的青金、红被直接删掉，同时凭空多出一颗草莓、一颗白。
   *     顾客看到的正是「我配好的珠子没了，还多了我没选的」。
   *     一键工具**不得改动顾客的选材**，故改为纯重排（多重集守恒）。
   *
   *  回文可解条件：出现次数为**奇数**的「材质+珠径」至多一种（它落在正中）。
   *  不满足时返回 null，由调用方把「哪几种各只有一颗」说给顾客听，
   *  而不是擅自替他删掉几颗。
   *
   *  ⚠️ 分组键必须是 **id + 直径**，不能只用 id：
   *     白8mm 粉14mm 白12mm 若只按材质分组会被当成「两颗白水晶」，
   *     镜像后 12mm 那颗会被换成 8mm —— 材质没丢，珠子却已经被换掉了。
   */
  function mirrorSeq(seq) {
    const n = seq ? seq.length : 0;
    if (!n) return seq;
    const key = b => b.id + '|' + b.d;
    const groups = new Map();
    for (const b of seq) {
      const k = key(b);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
    let odd = 0;
    for (const arr of groups.values()) if (arr.length % 2) odd++;
    if (odd > 1) return null;                 // 排不成回文，交给调用方提示

    const left = [], mid = [];
    for (const arr of groups.values()) {
      const half = arr.length >> 1;
      for (let i = 0; i < half; i++) left.push(arr[i]);
      if (arr.length % 2) mid.push(arr[half]);   // 奇数颗的珠子放正中
    }
    const right = left.slice().reverse().map(b => ({ id: b.id, d: b.d }));
    return left.concat(mid, right);
  }

  /** 「各只有奇数颗」的珠子 —— 用来向顾客解释为什么排不成对称。
   *  按「材质+珠径」统计，返回 [{id, d, n}]（n 为该规格的实际颗数）。 */
  function oddIds(seq) {
    const cnt = new Map();
    for (const b of seq || []) {
      const k = b.id + '|' + b.d;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    const out = [];
    for (const [k, n] of cnt) {
      if (n % 2) {
        const [id, d] = k.split('|');
        out.push({ id, d: +d, n });
      }
    }
    return out;
  }

  /** 一键渐变：把**现有的珠子**按颜色深浅重排成一条连续色带 —— 不增颗、不换材质。
   *
   *  ⚠️ 旧实现走 gradientEven(首颗, 末颗, n)：只拿首尾两颗当端点，再从全库色卡
   *     拉一条色彩链铺满，中间的珠子全被替换成顾客没选过的珠材；首尾同色时
   *     更会整串退化成同一个颜色（白 草莓 草莓 白 → 白 白 白 白）。
   *     一键工具不得改动顾客的选材，故改为对现有珠子按亮度 L* 排序。
   *
   *  方向跟随首尾：首颗比末颗亮就由浅到深，反之由深到浅 —— 顾客原先把谁放在
   *  开头，就顺着谁的走向，而不是一律「浅色在前」。首尾同亮度时取「亮色在前」，
   *  这样顾客配的浅色首颗不会被翻到队尾，且重复点击结果稳定（幂等）。
   *  JS 的 sort 是稳定排序，同亮度的珠子保持原有相对顺序。
   */
  function gradientSeq(seq) {
    const n = seq ? seq.length : 0;
    if (n < 2) return seq;
    const L = b => (MAP[b.id] ? MAP[b.id].lab[0] : 0);
    const desc = L(seq[0]) >= L(seq[n - 1]);
    return seq.slice().sort((a, b) => desc ? L(b) - L(a) : L(a) - L(b));
  }
  /** 色带分段（按 id 压缩连续段，用于可视化与校验） */
  function bandsOf(seq) {
    const bs = [];
    for (const b of seq) {
      const last = bs[bs.length - 1];
      if (last && last.id === b.id && last.d === b.d) last.n++;
      else bs.push({ id:b.id, d:b.d, n:1 });
    }
    return bs;
  }

  /* ======================================================================
   * 渲染布局：把序列展开成每颗珠子的**像素**坐标
   *
   * ⚠️ 为什么坐标换算必须放在 core 里，不能由 UI 各算一份：
   *   ① 单位不同 —— 模型层是毫米，画布是像素，差一个 scale；
   *   ② 角度原点不同 —— 模型层从 0(3 点方向)起算，画布要让首颗在正上方，
   *      于是 draw 用 a-π/2 而 hitTest 用 a，两者错开 90°，点哪颗都命中错位珠子。
   *   这两个坑都曾真实发生，故 layout() 一并输出 x/y/r 像素值，
   *   draw 与 hitTest 共用同一份，物理上不可能再不一致。
   * ==================================================================== */
  const A0 = -Math.PI / 2;            // 首颗落在正上方
  const TAU = Math.PI * 2;
  /** 自适应缩放：让**外径**（珠心圆半径 + 珠子半径）填满给定的像素半径
   *
   *  ⚠️⚠️ 旧实现 `Math.min(2.2, 235 / Rc)` 有两个叠加的错误：
   *   ① 上限 2.2 把结果**恒定钳死** —— 实测 n=3/4/5/8/12/17/20 全部返回 K=2.2，
   *      「自适应」等于没有。n=3 时外径仅 28px（画布 310px，只占 9%），
   *      珠子互相挤成一团，R/r=1.15（珠半径比环半径还大）—— 即用户所见
   *      「清空后重新加几颗，手串变得非常小、珠子挤在一起」。
   *   ② 只除 Rc（珠心圆半径），**漏掉了珠子本身**，所以算出来的根本不是外径。
   *
   *  正确口径：K = maxOuterPx / (Rc + dmax/2)
   *    —— Rc 由外切条件解出，故 (Rc + dmax/2) 正是真实外缘半径；
   *       这样无论几颗珠子，环都能按同一比例填满画布，
   *       且因为几何上本就外切，放大后相邻珠子恰好相切，不会重叠。
   *
   *  maxOuterPx 由调用方按实际画布尺寸传入（画布 px 会随机型/rpx 变化，
   *  不能在 core 里硬编码）；缺省 235 仅为兼容原型旧口径。
   */
  function fitScale(Rc, dmax, maxOuterPx) {
    const outerMm = Rc + (dmax || 0) / 2;
    if (!(outerMm > 0)) return 2.2;
    const target = maxOuterPx > 0 ? maxOuterPx : 235;
    return target / outerMm;
  }

  /* 珠径档位权重。12mm 是水晶手串绝对主流（销量占比最高），
 * 8mm 偏小珠、做 20+ 颗显得碎且不常见，故给低权重。
 * ⚠️ 这些权重是**按市面观感估计的**，上线前应以实际订单分布校准。*/
  const SIZE_POOL = [
    { d: 12, w: 45 },   // 主流
    { d: 10, w: 28 },
    { d: 14, w: 19 },
    { d:  8, w:  8 },   // 少见
  ];
  const SIZE_TOTAL = SIZE_POOL.reduce((s, x) => s + x.w, 0);

  /** 按权重抽一个珠径 */
  function pickSize(rng) {
    let r = rng() * SIZE_TOTAL;
    for (const s of SIZE_POOL) { if ((r -= s.w) <= 0) return s.d; }
    return 12;
  }

  /* ======================================================================
   * 随机预设：一键得到一条成品，避免打开页面时预览区是空的
   * ==================================================================== */
  /** 按权重随机取一项 */
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  /* 六种配色风格。权重体现市面常见度：
   * 渐变与三色最常见，纯色单圈反而少（客户一般不会只买一色）。 */
  const STYLES = [
    { key:'grad', name:'渐变',   w:26, ids:['w','pk','am','nv'],grad:true      },
    { key:'trio', name:'三色',   w:24, ids:['w','am','ls'],       trio:true     },
    { key:'warm', name:'暖调',   w:18, ids:['ro','rd','ye','pk'], trio:true     },
    { key:'cold', name:'冷调',   w:14, ids:['ls','nv','gr','te'], trio:true     },
    { key:'mix',  name:'混搭径', w:10, ids:['w','pe','am','nv'], mixed:true    },
    { key:'solo', name:'素串',   w: 8, ids:['am','ls','gr','te','nv'],single:true },
  ];
  const STYLE_TOTAL = STYLES.reduce((s, x) => s + x.w, 0);

  /** 按权重抽一种风格 */
  function pickStyle(rng) {
    let r = rng() * STYLE_TOTAL;
    for (const s of STYLES) { if ((r -= s.w) <= 0) return s; }
    return STYLES[0];
  }

  /** 生成一条随机成品序列
   *
   *  @param {number} target 目标内缘周长（mm），用于定颗数
   *  @param {function} [rng] 随机源，缺省 Math.random（测试可注入以复现）
   *  @param {number[]} [sizes] 珠径池，缺省自选
   */
  function randomPreset(target, rng, sizes) {
    const R = rng || Math.random;
    let style = pickStyle(R);
    /* ⚠️ 只给一档珠径时（店主预设规格），必须跳过「混搭径」风格：
       否则会产出一条全同径的手串却顶着「混搭径」的名字，名实不符。
       判定依据是**调用方给的规格**，不是抽到的风格——所以放在这里而不是改权重。 */
    if (sizes && sizes.length === 1 && style.mixed) {
      style = STYLES.filter(s => s.key === 'solo')[0] || style;
    }

    // 珠径：素串固定一档，「混搭径」强制两档，其余可单档
    let ds;
    if (sizes && sizes.length) ds = sizes.slice();
    else if (style.mixed) {
      const a = pickSize(R);
      let b = pickSize(R);
      if (b === a) b = a >= 12 ? a - 2 : a + 2;
      ds = [Math.min(a, b), Math.max(a, b)];
    } else ds = [pickSize(R)];

    // 颗数按**等效均径**反推 —— 混搭时若按最大珠径算会明显偏少
    const avgD = ds.reduce((s, d) => s + d, 0) / ds.length;
    const n = suggestCount(target, avgD);

    let ids;
    if (style.grad) {
      ids = gradientEven(style.ids[0], style.ids[style.ids.length - 1], n);
    } else if (style.single) {
      const id = pick(R, style.ids);
      ids = Array.from({ length:n }, () => id);
    } else if (style.trio) {
      /* 主色铺底（约 60%），另两色点缀。
       * 刻意避免固定 i%4 的机械节奏——真实手串不会每 4 颗一循环，
       * 固定节奏看起来像程序生成而非随机搭配。 */
      const [a, b, c] = style.ids;
      const rB = 0.08 + R() * 0.14;      // b 的密度
      const rC = 0.06 + R() * 0.12;      // c 的密度
      ids = Array.from({ length:n }, (_, i) => {
        const r = R();
        if (i > 0 && i < n - 1 && r < rB) return b;   // 首尾留主色，收口更稳
        if (i > 1 && i < n - 1 && r < rB + rC) return c;
        return a;
      });
      // 保证至少用到两种色，否则退化成素串就不是三色了
      if (new Set(ids).size < 2) ids[n - 1] = b;
    } else {
      ids = Array.from({ length:n }, () => pick(R, style.ids));
    }

    // 混搭按珠径池交替分配；渐变风格单档，故不打乱配色走向
    const seq = ids.map((id, i) => ({ id: id, d: ds.length > 1 ? ds[i % ds.length] : ds[0] }));
    return { seq: seq, style: style, name: style.name, sizes: ds };
  }

  function layout(seq, scale, maxOuterPx) {
    const ds = seq.map(b => b.d);
    const g = solveLoop(ds);
    if (!g.ok) return g;
    const dmax = Math.max.apply(null, ds);
    /* maxOuterPx：画布可容纳的最大外缘半径(px)，由调用方按实际画布尺寸给出 */
    const K = scale > 0 ? scale : fitScale(g.Rc, dmax, maxOuterPx);
    const R = g.Rc * K;                       // 像素半径
    const out = [];
    let acc = 0;
    for (let i = 0; i < seq.length; i++) {
      const a = acc + A0;
      out.push({ b: seq[i], a: a, r: seq[i].d / 2 * K,           // r = 像素
                 x: R * Math.cos(a), y: R * Math.sin(a) });
      acc += g.th[i];
    }
    return { ok:true, Rc:g.Rc, ri:g.ri, th:g.th, innerPerim:g.innerPerim,
             avgD:g.avgD, mixed:g.mixed, chordSum:g.chordSum,
             K: K, R: R, n: seq.length, items: out };
  }
  /** 命中测试：找出被 (x,y) 点中的珠子索引
   *  x/y 为**像素**坐标且已减去画布中心；L 必须由 layout() 按同一 scale 生成 */
  function hitTest(L, x, y, tol) {
    if (!L.ok) return -1;
    const t = tol || 6;
    let best = -1, bd = Infinity;
    for (let i = 0; i < L.items.length; i++) {
      const it = L.items[i];
      const d = Math.hypot(it.x - x, it.y - y);
      if (d < it.r + t && d < bd) { bd = d; best = i; }
    }
    return best;
  }
  /** 拖动落点：把 (x,y) 换算成目标槽位索引（用于交换/插入）
   *
   *  ⚠️ 语义是「角距最近的珠子」，而不是「累加 θ 找区间」：
   *     槽位边界应落在**珠子之间**（中垂线）。若先 acc+=th[i] 再比较，
   *     边界正好压在第 i+1 颗珠心角上，于是每颗珠子正上方都会落到前一槽，
   *     且偏移随珠径分布而变（混搭时更明显）。改为就近取最近珠子即免疫。
   *
   *  落在内孔里（远离珠环）返回 -1 —— 用户拖到正中通常是握持而非选位，
   *  此时若照样交换会频繁误操作，故显式判定为「无处可放」。 */
  function slotFromPoint(L, x, y) {
    if (!L.ok || !L.n) return -1;
    let maxR = 0;
    for (let i = 0; i < L.items.length; i++) maxR = Math.max(maxR, L.items[i].r);
    if (Math.hypot(x, y) < (L.R - maxR) * 0.8) return -1;
    const a = Math.atan2(y, x);                 // 画布角（y 向下，与 items[].a 同系）
    let best = 0, bd = Infinity;
    for (let i = 0; i < L.n; i++) {
      let d = a - L.items[i].a;
      while (d < -Math.PI) d += TAU;
      while (d > Math.PI) d -= TAU;
      const ad = Math.abs(d);
      if (ad < bd) { bd = ad; best = i; }
    }
    return best;
  }

  /** 拖动落点的**意图判定** —— 区分「落在某颗珠子上」与「落在两珠之间」。
   *
   *  返回 { mode, target, gap }：
   *    mode='swap'   落在第 target 颗珠子上        → 松手与它交换
   *    mode='insert' 落在第 gap 与 gap+1 颗之间     → 松手插入这个缝隙
   *    mode='none'   落在内孔（离珠环太远）        → 不做任何改动
   *
   *  ⚠️ 两种模式必须分开，不能用同一个「最近槽位」糊过去：
   *     交换是「两颗珠子换位」，插入是「把一颗塞进两颗之间」，
   *     用户拖到珠子上还是两珠之间，是两种完全不同的意图，结果也不同。
   *
   *  判定用两种度量，各自取其所长：
   *     · 是否落在珠上 → **欧氏距离**（珠子是圆，圆内即命中，与角度无关）
   *     · 落在哪个缝隙 → **角距**（缝隙是环上的角度区间）
   *  容差 ratio 是珠半径的比例（默认 0.85）：取 1.0 会把「两珠相切处的中缝」
   *  也算成命中（相切时缝正中到两珠心都恰好 = r），中缝就永远判不出插入。
   */
  function dropIntent(L, x, y, ratio) {
    if (!L.ok || !L.n) return { mode: 'none', target: -1, gap: -1 };

    let maxR = 0;
    for (let i = 0; i < L.items.length; i++) maxR = Math.max(maxR, L.items[i].r);
    /* 内孔：离珠环太远，视为「无处可放」（与 slotFromPoint 同一口径） */
    if (Math.hypot(x, y) < (L.R - maxR) * 0.8) return { mode: 'none', target: -1, gap: -1 };

    /* ① 落在某颗珠子上 → 交换 */
    const tol = ratio > 0 ? ratio : 0.85;
    let bi = -1, bd = Infinity;
    for (let i = 0; i < L.n; i++) {
      const d = Math.hypot(x - L.items[i].x, y - L.items[i].y);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0 && bd <= L.items[bi].r * tol) {
      return { mode: 'swap', target: bi, gap: -1 };
    }

    /* ② 在珠环上但不在任何珠子里 → 插入到所在缝隙。
       缝隙 g 覆盖角度区间 [items[g].a, items[g].a + th[g]]。 */
    const a = Math.atan2(y, x);
    for (let g = 0; g < L.n; g++) {
      let d = a - L.items[g].a;
      d = ((d % TAU) + TAU) % TAU;            // 归一化到 [0, TAU)
      if (d <= L.th[g]) return { mode: 'insert', target: -1, gap: g };
    }
    /* 浮点兜底：落到最后一颗上 */
    return { mode: 'swap', target: bi, gap: -1 };
  }

  /** 把「落点意图」应用到序列上 —— 纯函数，不改变入参。
   *
   *  insert 的目标下标要按「取出 from 之后」的坐标系换算：
   *    取出后 from 之后的元素整体前移一位，故
   *      from <= g 时目标下标 = g（原 g 已前移到 g-1，插到它后面）
   *      from >  g 时目标下标 = g + 1
   *  举例（seq=0..4）：
   *    把 0 插到 1、2 之间（g=1）→ [1,0,2,3,4]
   *    把 4 插到 1、2 之间（g=1）→ [0,1,4,2,3]
   *  两者都成立，说明换算正确。
   */
  function applyDrop(seq, from, intent) {
    if (!intent || from < 0 || from >= seq.length) return seq;
    if (intent.mode === 'swap') {
      const t = intent.target;
      if (t < 0 || t === from) return seq;          // 拖回自己身上 = 无操作
      return swapItems(seq, from, t);
    }
    if (intent.mode === 'insert') {
      const g = intent.gap;
      if (g < 0) return seq;
      return moveItem(seq, from, from <= g ? g : g + 1);
    }
    return seq;
  }

  /** 插入预览布局：把落点那道缝**撑开**，让 B、C 真正分开让位。
   *
   *  ⚠️ 为什么不能直接用 applyDrop 的结果来画：
   *     等径环有 n 重旋转对称 —— 把珠子重排一遍，各槽位坐标**一模一样**，
   *     屏幕上看不出任何"让开"。而顾客的珠子通常都是同一档直径，
   *     等径正是常态。所以"重排后自然让开"是个错觉，必须显式撑开。
   *
   *  做法：把 gap 处的槽角从「B、C 相切」放大到「B-A-C 三段相切」所需的角宽
   *  （即 need = θ(BA) + θ(AC)），其余槽角仍按标准公式，再解出新的 Rc
   *  使总角仍为 2π。因为要摊掉更大的角，Rc 必然变大 —— 环会自然地"绷开"一点。
   *
   *  数学上这恰好等价于「n+1 颗（含 A 占位）的稳态布局」：
   *     等径 n 颗时 Rc = r/sin(π/n)，撑开后解得 Rc = r/sin(π/(n+1))，
   *     与 n+1 颗的闭式解完全一致。
   *
   *  缩放仍取标准布局的 K：K 若跟着变，拖动时整条手串会忽大忽小，
   *  像换了一条串 —— 撑开应该只体现为"环绷开"，不体现为"整体缩放"。
   */
  function layoutWithGap(seq, from, gap, maxOuterPx) {
    const n = seq ? seq.length : 0;
    if (n < 4 || from < 0 || from >= n || gap < 0 || gap >= n) return null;
    const base = layout(seq, 0, maxOuterPx);
    if (!base.ok) return null;

    const ds = seq.map(b => b.d);
    const dA = ds[from], dB = ds[gap], dC = ds[(gap + 1) % n];
    const dmax = Math.max.apply(null, ds);
    /* 单条槽角的公式与 slotAngles 保持一致：θ = 2·asin(弦长 / (2·Rc)) */
    const thOf = (d1, d2, Rc) => 2 * Math.asin(Math.min(1, (d1 + d2) / 2 / (2 * Rc)));
    const needOf = Rc => thOf(dA, dB, Rc) + thOf(dA, dC, Rc);

    /* f(Rc) = 其余槽角之和 + 撑开后的落点槽角 - 2π；随 Rc 单调递减 */
    const f = Rc => {
      let s = 0;
      for (let i = 0; i < n; i++) {
        if (i === gap) continue;
        s += thOf(ds[i], ds[(i + 1) % n], Rc);
      }
      return s + needOf(Rc) - 2 * Math.PI;
    };
    let lo = dmax / 2 * 1.0000001, hi = dmax * 200 + 1000;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid; else hi = mid;
    }
    const Rc = (lo + hi) / 2;
    const K = base.K;                       // 与标准布局同尺，避免整串缩放跳变
    const R = Rc * K;
    const gapW = needOf(Rc);

    const items = [];
    let acc = A0;
    for (let i = 0; i < n; i++) {
      items.push({ b: seq[i], a: acc, r: ds[i] / 2 * K,
                   x: R * Math.cos(acc), y: R * Math.sin(acc) });
      acc += (i === gap ? gapW : thOf(ds[i], ds[(i + 1) % n], Rc));
    }
    /* 空位中心 = B、C 夹角平分线；半径取 A 的珠半径 */
    return {
      ok: true, n, R, Rc, K, items,
      grown: R - base.R,                       // 环绷开的像素量（可断言 > 0）
      gapAfter: gap,
      gapMid: { a: items[gap].a + gapW / 2, r: dA / 2 * K },
    };
  }

  return {
    BEADS, MAP, PALM_RATIO, CORD_FEE, PRICE_LADDER, priceOf,
    solveLoop, slotAngles, sumAngles, slotsFor, geom, suggestCount, stretchOf, fitVerdict, fitAdvice,
    fitBand, stretchAtCount, resizeAdvice,
    ciede2000, nearest, projAxis, gradientPath, gradientEven, canonKey,
    seqDs, addOne, insertAt, replaceAt, removeAt, moveItem, swapItems,
    mirrorSeq, oddIds, gradientSeq, bandsOf,
    layout, hitTest, slotFromPoint, dropIntent, applyDrop, layoutWithGap, fitScale,
    randomPreset, pickStyle, pickSize, STYLES, SIZE_POOL,
  };
});