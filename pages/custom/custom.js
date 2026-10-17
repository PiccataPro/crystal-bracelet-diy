/* pages/custom/custom.js —— 定制核心页（阶段一：本地验证）
 *
 *⚠️ 分层纪律：本文件**零算法**。
 *    尺寸换算、闭环求解、定价、渐变、配色去重全部在 utils/bracelet-core.js。
 *    这里的每个数字都从 core 拿，不要在本文件里重算——
 *    原型阶段就是因为 UI 层自带了一份坐标换算副本，两处不一致导致拖动命中错位90°。
 *
 * ⚠️ 状态存放纪律：手串序列 seq 存在 this.seq（Page 实例属性），**不进data**。
 *    原因：拖动时每帧都要改 seq，走 setData 会因跨线程序列化导致明显卡顿。
 *    只有需要渲染到 WXML 的数据（报价、颗数、提示语）才进 data。
 */

const C = require('../../utils/bracelet-core.js');
const Order = require('../../utils/order-store.js');

/* 珠径档位 —— **店主预置的可售规格**。
 *
 * ⚠️ 为什么放 UI 层常量而不进 core：
 *    「本店备哪几档现货」是**运营规格**，不是几何性质。
 *    core 的 SIZE_POOL 是「市面常见度权重」，用于随机成品，两者语义不同。
 * 上线时应把这里改成从后台/云配置下发（店主在管理端设置），
 * 届时只需替换取值来源，其余代码（筛选、拖入、预设、补满、定价）全部跟着走。
 *
 * 珠材库 = 材质 × 直径 的组合，每个组合是一个可售 SKU；
 * 客人可在筛选条里切换，但只能在这几档内挑。 */
const D_SIZES = [8, 10, 12, 14];
/** 默认筛选档（主力现货） */
const DEFAULT_D = 12;

/* 筛选条：全部 + 四档。
   ⚠️ 值一律用**字符串**：小程序 dataset 走 attribute 通道，
      字符串比较最稳，避免 '12' 与 12 混用导致恒不相等。 */
const D_FILTERS = [{ v: 'all', label: '全部' }].concat(
  D_SIZES.map(d => ({ v: String(d), label: d + 'mm' }))
);

/* 可执行建议的文案表。core.fitAdvice 只吐语义码 ——
   中文属运营话术，会随店铺口径调整，不该写进算法文件。 */
const ADVICE_LABEL = {
  ok: '合理',
  add: '建议增加珠子',
  cut: '建议减少珠子',
  smaller: '建议换小珠子',
  bigger: '建议换大珠子'
};

/* 序列条珠子的显示尺寸：mm -> rpx。
 * ⚠️ 为什么不用 px：750rpx = 屏宽，px↔rpx 的比例**每台手机都不同**。
 *    用 px 的话，同一颗 12mm 珠在 414 宽机型上视觉只有 375 宽机型的 90%，
 *    而且会与画布里按毫米真实比例画出的珠子对不上。
 * 取 14mm = 64rpx（屏宽 8.5%，视觉合适），其余按真实比例 8:10:12:14 = 4:5:6:7 折算。
 * 这只是**显示比例**，不是物理尺寸——物理尺寸仍由 core 按毫米算。 */
const DOT_RPX = { 8: 37, 10: 46, 12: 55, 14: 64 };

/* 珠材一句话介绍 —— 纯 UI 文案，**不进 core**（core 只管几何与定价）。
   放 UI 层的原因：这是营销话术，会随运营调整，不该动算法文件。 */
const BEAD_INTRO = {
  w:  '纯净通透，传统主净化与清醒',
  pk: '粉色内含物如草莓籽，主招桃花',
  ro: '温柔粉调，人称「爱情石」',
  am: '紫色典雅，主智慧与安宁',
  te: '茶褐沉稳，百搭耐看',
  ye: '明黄透亮，主财运与自信',
  ls: '深蓝缀金点，古称帝王之石',
  nv: '极深蓝调，低调显白',
  gr: '绿色包裹体，主事业与机遇',
  rd: '暖红厚重，主活力',
  bk: '纯黑镜面，主辟邪挡煞',
  pe: '温润珠光，优雅经典'
};

Page({
  data: {
    /* --- 珠材库：材质 × 直径的组合（店主预置的 SKU） --- */
    dFilters: D_FILTERS,            // 珠径筛选条的选项
    filterD: String(DEFAULT_D),     // 当前筛选档，'all' = 全部
    libView: [],                    // 当前筛选下可见的 SKU（只渲染这个）

    /* --- 尺寸设置 --- */
    wrist: 165,
    ease: 12,
    cord: 'elastic',
    cordOptions: [
      { value: 'elastic', label: '弹力线' },
      { value: 'wax', label: '蜡绳活结' }
    ],
    easeOptions: [
      { value: 6, label: '偏紧' },
      { value: 12, label: '标准' },
      { value: 15, label: '偏松' }
    ],

    /* --- 展示态（唯一真源是 this.seq，这些只是给 WXML 看的快照） --- */
    seqView: [],        // 排列顺序条的快照
    beadsCost: 0,
    cordFee: 0,
    total: 0,
    priceDetail: '',
    presetHint: '',
    bandHint: '',
    verdict: null,      // {level, msg}
    adviceLabel: '',    // 主建议文案，如「建议增加珠子」
    adviceLevel: '',    // 与 verdict.level 同值，用于配色
    adviceAlt: '',      // 副建议：守住颗数时的换径备选，如「或换 10mm 珠」
    selIdx: -1,
    canvasTag: '拖动重排 · 拖到别珠上互调',

    /* --- 下单 --- */
    canOrder: false,    // 颗数 >= 3（能成环）才可下单
    orderHint: '',      // 下单成功后的提示（含单号）

    /* --- 珠材库交互（配珠台左侧竖列） --- */
    expandedId: '',        // 当前展开「直径+价格+介绍」的 SKU key；'' = 全部收起
    dragOverCanvas: false, // 手指是否已拖到画布上方（驱动 .stage-over 高亮提示）
    libDragging: false,    // 已判定为「横向拖珠」→ 锁住列表滚动与页面滚动
    dragLock: false,       // 正在画布内拖珠 → 锁住页面滚动（见 onTouchStart/onTouchEnd）

    /* --- 珠材库拖拽的跟手浮层 --- */
    ghostOn: false,        // 是否显示跟随手指的珠子浮层（越过死区才亮）
    ghostX: 0,             // 浮层中心 x（clientX 坐标系）
    ghostY: 0,             // 浮层中心 y
    ghostHex: '#cfcfcf',   // 浮层珠子颜色 = 所拖 SKU 的颜色
    ghostD: 12,            // 浮层珠子直径（mm），用于换算浮层大小
    ghostSize: 40,         // 浮层像素直径（JS 预计算，WXML 不支持表达式）

    /* --- 拖入删除（垃圾桶） --- */
    dragOverTrash: false,  // 手环上的珠子是否已被拖到垃圾桶上方

    /* 色带分段 */
    bands: [],
    seqCount: 0
  },

  /* ============ 非响应式私有状态 ============ */
  /** @type {{id:string,d:number}[]} 当前手串序列 */
  seq: [],
  /** 全部 SKU（材质×直径）。48 条，不进 data —— WXML 只渲染筛选后的 libView */
  _libAll: [],
  /** 当前选中索引，-1 为未选中 */
  sel: -1,
  /** 拖动态{from,dx,dy,x,y,to}，null 为非拖动 */
  drag: null,
  /** 珠材库拖拽态 {id,x0,y0,over}，null 为未拖拽 */
  libDrag: null,
  /** 本次珠材库触摸是否已越过死区（用于区分点击/拖拽，并吞掉拖拽后补发的 tap） */
  _libDragged: false,
  /** 跟手浮层上次刷新时间戳，用于 16ms 节流（非响应式） */
  _ghostAt: 0,
  /** Canvas 2D 上下文与像素尺寸 */
  ctx: null,
  cvSize: 0,
  /**
   * ⚠️ 画布在视口中的偏移量（相对屏幕左上角的 left/top，单位 px）。
   * 触摸事件的 clientX/clientY 是**相对视口**的，不是相对画布的；
   * 必须减去这个偏移才能得到画布内的坐标。
   * 页面可滚动 → 滚动时要用 onPageScroll 刷新。
   * @type {{left:number,top:number}}
   */
  cvRect: { left: 0, top: 0 },
  /**
   * 垃圾桶在视口中的矩形（含 right/bottom）。拖入删除的判定基准。
   * ⚠️ 必须与 cvRect 一样在滚动后刷新，否则页面滚过之后桶区会整体偏移。
   * @type {{left:number,top:number,right:number,bottom:number}|null}
   */
  trashRect: null,
  /** 最近一次布局结果，命中测试与渲染共用（坐标系同源） */
  L: null,

  /* ==================================================================
   * 生命周期
   * ================================================================== */

  onLoad() {
    /* 珠材库 = 材质 × 直径 的全部组合（48 条）。材质名/色值来自 core，
       单价一律走 core.priceOf（按规格跳档），UI 不自带价格副本。
       intro（一句话介绍）属 UI 文案，在此补充，不污染 core。 */
    const all = [];
    for (const b of C.BEADS) {
      for (const d of D_SIZES) {
        all.push({
          key: b.id + '-' + d,      // 唯一键：同材质不同直径必须能区分
          id: b.id,
          name: b.name,
          hex: b.hex,
          d: d,
          curPrice: C.priceOf(b.id, d),
          intro: BEAD_INTRO[b.id] || ''
        });
      }
    }
    this._libAll = all;
    this.setData({ libView: this.filterLib(this.data.filterD) });

    /* 首屏自动配好一条成品，不出现空环（C-18） */
    this.loadPreset();
  },

  /** 按珠径筛选出当前可见的珠材。'all' = 不过滤 */
  filterLib(f) {
    const all = this._libAll || [];
    if (f === 'all') return all;
    const d = +f;
    return all.filter(x => x.d === d);
  },

  /** 切换珠径筛选。展开态一并收起 —— 原先展开的那条很可能已被筛掉 */
  onFilterD(e) {
    const v = String(e.currentTarget.dataset.v);
    if (!v || v === this.data.filterD) return;
    this.setData({
      filterD: v,
      libView: this.filterLib(v),
      expandedId: ''
    });
  },

  onReady() {
    this.initCanvas();
  },

  /* ==================================================================
   * Canvas 初始化
   *
   * ⚠️ 小程序 Canvas 2D 必须异步取节点（与浏览器最大的不同）：
   *    浏览器 document.getElementById 是同步的，
   *    小程序必须走 createSelectorQuery().select('#cv').fields({node:true}).exec()
   *
   * ⚠️⚠️ 必须处理 dpr（设备像素比）—— 这是社区反馈的经典坑：
   *    不处理 dpr 的话，开发者工具里有效果，真机预览画布可能空白或发虚。
   *    做法：canvas.width/height 设为 逻辑尺寸×dpr，再 ctx.scale(dpr,dpr)，
   *    之后所有绘制都按逻辑尺寸（rpx换算后的 px）来写。
   * ================================================================== */
  initCanvas() {
    const query = this.createSelectorQuery();
    /* rect:true 一次拿到 node/size/位置，避免二次查询。
       垃圾桶矩形顺带在**同一次** exec 里取回：两次查询之间有布局风险，
       而且多一次往返就多一次可能的时序问题。 */
    query.select('#cv')
      .fields({ node: true, size: true, rect: true });
    query.select('#trash')
      .boundingClientRect();
    query.exec((res) => {
      if (!res || !res[0]) {
        console.error('[水晶手串] 未找到 canvas 节点，检查 wxml 里 id="cv" 是否存在');
        return;
      }
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');

      /* 取渲染宽高（px）与设备像素比 */
      const cw = res[0].width;
      const ch = res[0].height;

      /* 记录画布在视口中的位置 —— 触摸坐标换算的基准 */
      this.cvRect = { left: res[0].left || 0, top: res[0].top || 0 };
      this.setTrashRect(res[1]);

      let dpr = 1;
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        dpr = info.pixelRatio || 1;
      } catch (e) {
        console.warn('[水晶手串] 取 pixelRatio 失败，退回 dpr=1', e.message);
      }

      /* 逻辑尺寸用 CSS px 传入的 width/height；位图尺寸乘 dpr 保证清晰 */
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      ctx.scale(dpr, dpr);

      this.ctx = ctx;
      this.cvSize = cw;   // 后续绘制一律用这个逻辑尺寸

      console.log('[水晶手串] canvas 初始化完成 逻辑尺寸', cw,
        'dpr', dpr, 'rect', JSON.stringify(this.cvRect));
      this.render();
    });
  },

  /* ==================================================================
   * 刷新画布在视口中的位置
   *
   * 页面可滚动，滚动后 canvas 的 top 会变；触摸事件的 clientX/Y 是
   * 相对视口的，所以每次滚动都必须重新取 rect，否则触点会整体偏移。
   * ================================================================== */
  refreshCvRect(cb) {
    /* 防御：单测桩 / 极早期调用可能没有 createSelectorQuery。
       取不到 rect 时沿用上一次缓存值，不影响主流程。 */
    if (typeof this.createSelectorQuery !== 'function') {
      if (typeof cb === 'function') cb();
      return;
    }
    try {
      this.createSelectorQuery()
        .select('#cv')
        .boundingClientRect((r) => {
          if (r) this.cvRect = { left: r.left, top: r.top };
          if (typeof cb === 'function') cb();
        })
        .exec();
    } catch (e) {
      console.warn('[水晶手串] refreshCvRect 失败，沿用缓存 rect', e.message);
      if (typeof cb === 'function') cb();
    }
  },

  /** 页面滚动 → 画布与垃圾桶的视口位置都变了 → 一起刷新 */
  onPageScroll() {
    this.refreshCvRect();
    this.refreshTrashRect();
  },

  /* ==================================================================
   * 垃圾桶（拖入删除）
   * ================================================================== */

  /**
   * 写入垃圾桶矩形。rect 来自 boundingClientRect（含 width/height）。
   * ⚠️ 缺 width/height 时直接忽略：宁可没有桶区（删不掉），
   *    也不能算出 NaN 边界把「任何位置」都判成桶区（会误删珠子）。
   */
  setTrashRect(rect) {
    if (!rect || typeof rect.width !== 'number' || typeof rect.height !== 'number') return;
    this.trashRect = {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height
    };
  },

  /** 刷新垃圾桶矩形（与 refreshCvRect 同一套防御：桩环境 / 查询失败时沿用旧值） */
  refreshTrashRect() {
    if (typeof this.createSelectorQuery !== 'function') return;
    try {
      this.createSelectorQuery()
        .select('#trash')
        .boundingClientRect((r) => this.setTrashRect(r))
        .exec();
    } catch (e) {
      console.warn('[水晶手串] refreshTrashRect 失败，沿用缓存 rect', e.message);
    }
  },

  /** 画布在视口中的矩形（补上右下角）。cvSize 与 cvRect 同为逻辑 px，可直接相加 */
  cvBox() {
    const r = this.cvRect, S = this.cvSize;
    return { left: r.left, top: r.top, right: r.left + S, bottom: r.top + S };
  },

  /** 两个轴对齐矩形是否相交 */
  rectsOverlap(a, b) {
    return a.left < b.right && b.left < a.right &&
           a.top < b.bottom && b.top < a.bottom;
  },

  /**
   * 手指（视口坐标）是否落在垃圾桶上。
   *
   * ⚠️⚠️ 安全阀：若垃圾桶矩形与画布矩形相交，**直接判定为不在桶上**。
   *    原因是手串颗数一多，环跟着变大，珠子会被画到画布边缘；
   *    桶区一旦压在画布上，那些珠子看上去就是「自动落入垃圾桶」，
   *    手指随手一拖就会被误删。宁可失去删除能力，也不接受误删。
   *    （正常情况下二者分处画布左右两侧，永不重叠；这里是防布局改坏。）
   */
  pointInTrash(cx, cy) {
    const t = this.trashRect;
    if (!t || !this.cvSize) return false;
    if (this.rectsOverlap(t, this.cvBox())) return false;
    return cx >= t.left && cx <= t.right && cy >= t.top && cy <= t.bottom;
  },

  /* ==================================================================
   * 渲染（唯一一处画布绘制入口）
   * ================================================================== */
  render() {
    const ctx = this.ctx;
    if (!ctx) return;                    /* 还没 onReady，等initCanvas 回调 */
    const S = this.cvSize;
    if (!S) return;
    const cx = S / 2, cy = S / 2;

    ctx.clearRect(0, 0, S, S);

    if (!this.seq.length) {
      ctx.fillStyle = '#888780';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('点击左侧珠材库开始配珠', cx, cy);
      this.L = null;
      return;
    }

    /* 布局交给 core：K/R/items[].x,y,r 全是像素，与画布同源。
       ⚠️ 第三个参数是「画布能容纳的最大外缘半径(px)」——
       core 不能硬编码画布尺寸（rpx 换算后 px 随机型变化），
       必须由这里按实际 cvSize 给出。0.85 是留边系数：
       环直径约占画布 85%，两侧各留约 7.5% 余量，
       避免珠子跟手放大 8%（r = it.r * 1.08）时被画布边缘裁掉。 */
    const L = C.layout(this.seq, 0, this.cvSize / 2 * 0.85);
    if (!L.ok) { this.L = null; return; }
    this.L = L;

    const dragIdx = (this.drag && this.drag.from < this.seq.length) ? this.drag.from : -1;
    const intent = this.drag ? this.drag.intent : null;

    /* 插入预览：把落点那道缝**撑开**，B、C 分开让位、环随之绷开一点。
       不能用 applyDrop 的重排结果来画 —— 等径环有 n 重旋转对称，
       重排一遍各槽位坐标分毫不差，屏幕上根本看不出"让开"。
       判定的依据仍是上面那份真实布局 L，绘制与判定职责分离。 */
    let drawL = L, gapMid = null;
    const pvIdx = dragIdx;
    if (dragIdx >= 0 && intent && intent.mode === 'insert') {
      const G = C.layoutWithGap(this.seq, dragIdx, intent.gap, this.cvSize / 2 * 0.85);
      if (G) { drawL = G; gapMid = G.gapMid; }
    }

    /* 绳子（用预览环半径画，插入时环会同步张开一点） */
    ctx.beginPath();
    ctx.arc(cx, cy, drawL.R - 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#C9C3B4';
    ctx.lineWidth = 5;
    ctx.stroke();

    /* 交换目标 = 松手后要跟 A 换位的那颗。
       它放大并压到最底层，让顾客看到「A 悬在 B 之上」——
       层级提前把松手的结果预告出来，而不是等松手才跳。 */
    const swapTarget = (intent && intent.mode === 'swap' &&
                        intent.target >= 0 && intent.target !== pvIdx)
      ? intent.target : -1;

    /* 绘制顺序 = 层级。特殊两颗单独挪位：
       目标珠降到最底（先画被压住），被拖珠抬到最顶（最后画盖住一切）。 */
    const order = [];
    for (let i = 0; i < drawL.items.length; i++) order.push(i);
    if (swapTarget >= 0) {
      const k = order.indexOf(swapTarget);
      if (k >= 0) order.splice(k, 1);
      order.unshift(swapTarget);
    }
    if (pvIdx >= 0) {
      const k = order.indexOf(pvIdx);
      if (k >= 0) order.splice(k, 1);
      order.push(pvIdx);
    }

    for (const i of order) {
      const it = drawL.items[i];
      const m = C.MAP[it.b.id];
      if (!m) continue;

      let x, y, r;
      if (i === pvIdx && this.drag) {
        x = cx + this.drag.x;
        y = cy + this.drag.y;
        r = it.r * 1.08;                /* 跟手时放大 8%，视觉上"拿起来了" */
      } else {
        x = cx + it.x;
        y = cy + it.y;
        r = it.r * (i === swapTarget ? 1.2 : 1);   /* 交换目标放大，暗示"要跟它换" */
      }

      /* 珠子本体：径向渐变模拟球体高光 */
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      const gr = ctx.createRadialGradient(
        x - r * .3, y - r * .33, r * .05,
        x, y, r * .62
      );
      gr.addColorStop(0, 'rgba(255,255,255,.95)');
      gr.addColorStop(.35, m.hex);
      gr.addColorStop(1, this.shade(m.hex, -42));
      ctx.fillStyle = gr;
      ctx.fill();

      /* 顶部小高光点 */
      ctx.beginPath();
      ctx.arc(x - r * .3, y - r * .34, r * .11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fill();

      /* 选中环。插入预览下下标语义已变，故只在真实布局上按 sel 画 */
      if (drawL === L && this.sel === i && i !== pvIdx) {
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#185FA5';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      /* 交换目标的落点圈 */
      if (i === swapTarget) {
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#D97706';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    /* 插入落点：在撑开的空位中心画一个虚线圆 —— B、C 已经分开，
       这个圈告诉顾客"A 将落在这里"。半径就用 A 自己的珠半径，
       所见即所得：松手后它就长在圈里。 */
    if (this.drag && gapMid) {
      const bead = this.seq[dragIdx];
      const m = bead ? C.MAP[bead.id] : null;
      const gx = cx + drawL.R * Math.cos(gapMid.a);
      const gy = cy + drawL.R * Math.sin(gapMid.a);
      ctx.save();
      ctx.beginPath();
      ctx.arc(gx, gy, gapMid.r, 0, Math.PI * 2);
      if (m) { ctx.fillStyle = m.hex; ctx.globalAlpha = 0.18; ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#D97706';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    /* 珠材库拖拽的**落点指示**：拖到环上时把目标槽位圈出来，
       让顾客在松手前就看到珠子会落在这里 —— 光有"松手插入此处"的文字
       还不够，得让位置本身可见。只读 this.libDrag，不进数据、不改布局。
       用蓝色虚线，与上面画布内拖动重排的橙色圈（#D97706）区分开。 */
    const slot = (this.libDrag && this.libDrag.over && this.libDrag.slot >= 0)
      ? this.libDrag.slot : -1;
    if (slot >= 0 && L.items[slot]) {
      const it = L.items[slot];
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx + it.x, cy + it.y, it.r + 3, 0, Math.PI * 2);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#185FA5';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  },

  /** 调整亮度生成阴影色。p<0 变暗，p>0 变亮。 */
  shade(hex, p) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (p < 0) {
      r = Math.round(r * (1 + p / 100));
      g = Math.round(g * (1 + p / 100));
      b = Math.round(b * (1 + p / 100));
    } else {
      r = Math.round(r + (255 - r) * p / 100);
      g = Math.round(g + (255 - g) * p / 100);
      b = Math.round(b + (255 - b) * p / 100);
    }
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  },

  /* ==================================================================
   * 画布触摸事件 —— 对应浏览器端的 pointer events
   *
   * ⚠️ 坐标系：core.layout 返回的 items[].x/y 已减去画布中心，
   *    所以触摸坐标也要先减中心再传，坐标系必须同源。
   * ================================================================== */

  onTouchStart(e) {
    if (!this.L || !this.seq.length) return;

    const raw = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!raw) return;
    const rawX = raw.clientX, rawY = raw.clientY;

    /* 异步补一次最新 rect：页面刚滚动过时缓存可能过期。
       不阻塞本次命中测试（用缓存值），回调里再重算偏移。
       垃圾桶同理 —— 漏刷新会让桶区整体偏一个滚动量。 */
    this.refreshCvRect();
    this.refreshTrashRect();
    if (this.data.dragOverTrash) this.setData({ dragOverTrash: false });

    const p = this.touchPoint(e);
    if (!p) return;

    const hit = C.hitTest(this.L, p.x - this.cvSize / 2, p.y - this.cvSize / 2, 8);
    if (hit < 0) {
      /*点到空白处 = 取消选中 */
      if (this.sel !== -1) {
        this.sel = -1;
        this.refresh();
      }
      return;
    }

    /* 记录偏移量：手指不一定点在珠心正上方 */
    const it = this.L.items[hit];
    this.drag = {
      from: hit,
      dx: (p.x - this.cvSize / 2) - it.x,
      dy: (p.y - this.cvSize / 2) - it.y,
      /**
       * ⚠️⚠️ 初值必须是珠子**当前**坐标（相对画布中心的偏移），绝不能写 0,0。
       *   render 里拖动中的珠子按 (cx + drag.x, cy + drag.y) 绘制，
       *   而 (0,0) 正好是画布圆心 —— 写 0 会导致按下瞬间整颗珠子被画到
       *   正中心，直到第一次 touchmove 才被 drag.x = lx - dx 修正回来。
       *   这正是「点下去珠子先飞到中间、随即又正常跟手」的原因。
       */
      x: it.x, y: it.y,
      /* 落点意图：{mode:'swap'|'insert'|'none'|'trash', target, gap}
         拖到某颗珠子上 = 交换；拖到两珠之间 = 插入；内孔 = 不动。
         初始为 none —— 按下还没移动时不该预告任何结果。 */
      intent: { mode: 'none', target: -1, gap: -1 }
    };
    this.sel = hit;

    /* rect 刷新完成后重算手指相对珠心的偏移：首帧若用了过期 rect，
       dx/dy 会带上 (left,top) 的误差，表现为第一次移动时再跳一下。 */
    const from = hit;
    this.refreshCvRect(() => {
      if (!this.drag || this.drag.from !== from || !this.L) return;
      const it2 = this.L.items[from];
      if (!it2) return;
      this.drag.dx = (rawX - this.cvRect.left - this.cvSize / 2) - it2.x;
      this.drag.dy = (rawY - this.cvRect.top - this.cvSize / 2) - it2.y;
    });

    /* ⚠️ 命中珠子即锁页面滚动（dragLock）：
       画布绑的是冒泡式 bindtouchmove，手指纵向拖动时手势会冒泡给页面，
       导致「拖珠子」被识别成「滚页面」——左右拖因纵向位移为 0 才看起来正常。
       dragLock 同时驱动 canvas 的 disable-scroll 与 page-meta 的 overflow:hidden。
       只锁「拖珠子」这一种情况：按在画布空白处仍可正常上下滚动页面。 */
    this.setData({ canvasTag: '松手放到目标位', dragLock: true });
    this.refresh();
  },

  onTouchMove(e) {
    if (!this.drag || !this.L) return;

    const raw = this.clientPoint(e);
    if (!raw) return;

    const lx = raw.x - this.cvRect.left - this.cvSize / 2;
    const ly = raw.y - this.cvRect.top - this.cvSize / 2;

    this.drag.x = lx - this.drag.dx;
    this.drag.y = ly - this.drag.dy;

    /* 落点意图三分：
       · 拖到某颗珠子上   → swap（交换）
       · 拖到两珠之间的缝 → insert（插入）
       · 落在内孔         → none（不放）
       桶区优先级最高，判为 trash（删除）。
       ⚠️ 判定必须基于**真实布局 this.L**（顾客珠子当前的实际位置），
       不能读「插入后」的预览布局 —— 否则预览一变、判定跟着变，会自激抖动。
       ⚠️ 桶区判定用**视口坐标**，落点判定用**画布内坐标**，两者不能混。 */
    const inTrash = this.pointInTrash(raw.x, raw.y);
    const intent = inTrash ? { mode: 'trash', target: -1, gap: -1 }
                           : C.dropIntent(this.L, lx, ly);
    this.drag.intent = intent;

    const tag = this.tagForIntent(intent, this.drag.from);
    if (tag !== this.data.canvasTag || inTrash !== this.data.dragOverTrash) {
      this.setData({ dragOverTrash: inTrash, canvasTag: tag });
    }

    this.render();   /* 拖动中高频重绘，不走 setData */
  },

  /** 落点意图 → 顶部提示文案。拖回自己身上/原位时要说「放回原位」，
   *  否则顾客会以为「拖着玩也会交换」，松手却发现什么都没发生。 */
  tagForIntent(intent, from) {
    if (!intent || intent.mode === 'none') return '松手放到目标位';
    if (intent.mode === 'trash') return '松手即删除这颗';
    if (intent.mode === 'swap') {
      return intent.target === from ? '松手放回原位' : '松手交换这两颗';
    }
    if (intent.mode === 'insert') {
      const n = this.seq.length;
      const g = intent.gap;
      /* 插到自己前面或后面那个缝 = 位置没变 */
      const same = (g === from) || (g === (from - 1 + n) % n);
      return same ? '松手放回原位' : '松手插入两珠之间';
    }
    return '松手放到目标位';
  },

  onTouchEnd() {
    /* 先解锁页面滚动，且早于下面的 early-return —— 触摸被系统 cancel
       （如被父级滚动/通知打断）时 drag 可能已清空，不在这里解就会残留锁死。 */
    if (this.data.dragLock) this.setData({ dragLock: false });

    if (!this.drag || !this.L) return;
    const from = this.drag.from;
    const intent = this.drag.intent;
    const overTrash = this.data.dragOverTrash;
    this.drag = null;

    /* 复位桶区高亮与提示语（删/换位都要复位） */
    this.setData({
      dragOverTrash: false,
      canvasTag: '拖动重排 · 拖到别珠上互调'
    });

    if (overTrash) {
      /* 拖进垃圾桶 = 删除这颗。选中索引要跟着平移，否则会指向错位的那颗。 */
      this.seq = C.removeAt(this.seq, from);
      if (this.sel === from) this.sel = -1;
      else if (this.sel > from) this.sel--;
      this.refresh();
      return;
    }

    /* 按落点意图执行：落在珠上 = 交换，落在缝里 = 插入，内孔 = 不动。
       applyDrop 是纯函数，原位/自身的情况会返回原数组（next === this.seq），
       此时不重排、也不动选中态。 */
    if (intent && (intent.mode === 'swap' || intent.mode === 'insert')) {
      const next = C.applyDrop(this.seq, from, intent);
      if (next !== this.seq) {
        this.seq = next;
        /* 选中态跟着珠子走：交换/插入后原来选中的那颗已换了位置，
           不更新的话蓝色选中圈会留在原地下标、指向另一颗珠子。
           insert 的目标下标与 applyDrop 内部一致：取出 from 之后，
           from 之后的整体前移一位，故 from<=g 时落在 g，否则落在 g+1。 */
        if (this.sel === from) {
          this.sel = intent.mode === 'swap'
            ? intent.target
            : (from <= intent.gap ? intent.gap : intent.gap + 1);
        }
      }
    }
    this.refresh();
  },

  /**
   * 从 touch 事件取**视口**坐标（原始值，未做任何换算）。
   * 优先 touches，退回 changedTouches —— 小程序在 touchend 时 touches 已空。
   * 所有坐标换算（画布内坐标、垃圾桶内坐标）都从这一个出口取值，避免各算各的。
   */
  clientPoint(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t) return null;
    return { x: t.clientX, y: t.clientY };
  },

  /**
   * 从 touch 事件取**画布内**坐标。
   *
   * ⚠️⚠️ 关键：t.clientX/clientY 是相对**视口**的，不是相对画布的。
   *    直接用会让触点整体偏移 (cvRect.left, cvRect.top)，
   *    表现为「手指按在珠子上，被拖动的却是另一颗/偏到内孔」。
   *    必须减去画布左上角在视口中的位置。
   */
  touchPoint(e) {
    const c = this.clientPoint(e);
    if (!c) return null;
    return { x: c.x - this.cvRect.left, y: c.y - this.cvRect.top };
  },

  /* ==================================================================
   * 珠材库 —— 点一次加一颗（C-17）
   * ================================================================== */
  onPickBead(e) {
    const ds = e.currentTarget.dataset || {};
    const id = ds.id;
    if (!id) return;
    /* 珠径由**所点的那一项**决定（店主预置的材质×直径组合），
       不存在全局「当前珠径」—— 换筛选就换一批 SKU，各带各的直径。 */
    const d = +ds.d || DEFAULT_D;

    /* 已选中某颗 = 替换它（材质与直径一并改），否则追加一颗 */
    if (this.sel >= 0 && this.sel < this.seq.length) {
      this.seq = C.replaceAt(this.seq, this.sel, id, d);
      this.sel = -1;
      this.refresh();
      return;
    }
    this.seq = C.addOne(this.seq, id, d);
    this.refresh();
  },

  /* ==================================================================
   * 珠材库 —— 点击展开「直径 + 价格 + 介绍」
   *
   * ⚠️ 与拖拽共存于同一元素：移动超过死区后小程序通常不再触发 tap，
   *    但边界情况可能补发，故用 _libDragged 明确吞掉，避免「拖完又被展开」。
   * ⚠️ 展开态用 **key（材质-直径）** 而不是 id：
   *    「全部」筛选下同材质的 4 条会同时出现，用 id 会一起展开。
   * ================================================================== */
  onTapLib(e) {
    if (this._libDragged) return;
    const key = e.currentTarget.dataset.key;
    if (!key) return;
    this.setData({ expandedId: this.data.expandedId === key ? '' : key });
  },

  /* ==================================================================
   * 珠材库 —— 拖到右侧手环即加一颗
   *
   * 三段式：start 记起点 → move 判定方向与落点 → end 按落点决定加在哪。
   * 画布矩形复用 this.cvRect（与画布内触摸换算同源），判定与视觉必然一致。
   *
   * ⚠️ 为什么必须做「方向判定」：
   *    这个手势和「滚动列表 / 滚动页面」共用同一块屏。若只看位移大小就接管，
   *    手指一竖着划，列表与页面同时跟着动、浮层又冒出来，两边打架 ——
   *    表现就是「过于敏感、容易造成翻页或页面上下滑动」。
   *    故：横着拖（去右侧画布）才接管并锁滚动，竖着划立刻放手交还给滚动。
   * ================================================================== */

  /** 手指坐标(clientX/Y)是否落在画布矩形内 */
  pointInCanvas(cx, cy) {
    const r = this.cvRect, S = this.cvSize;
    if (!S) return false;
    return cx >= r.left && cx <= r.left + S &&
           cy >= r.top && cy <= r.top + S;
  },

  /** 视口坐标 → 画布内坐标（原点在画布中心），与画布内拖动同一套换算 */
  canvasLocal(cx, cy) {
    const S = this.cvSize;
    if (!S) return null;
    return { x: cx - this.cvRect.left - S / 2, y: cy - this.cvRect.top - S / 2 };
  },

  onLibDragStart(e) {
    const ds = e.currentTarget.dataset || {};
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!ds.id || !t) return;
    /* 页面可滚动 → 拖拽开始时先刷新画布位置，避免用过期 cvRect 误判落点 */
    this.refreshCvRect();
    this._libDragged = false;
    this._ghostAt = 0;
    /* 浮层颜色取自所拖 SKU。查 **_libAll（全量 48 条）** 而不是 libView：
       后者随筛选变化，一旦拖拽起始时刻与渲染存在一拍差异就可能查空。 */
    const item = (this._libAll || []).find(v => v.key === ds.key) || {};
    this.libDrag = {
      id: ds.id,
      d: +ds.d || DEFAULT_D,      // 拖的是哪一档规格，就加哪一档
      hex: item.hex || '#cfcfcf',
      x0: t.clientX, y0: t.clientY,
      over: false,                // 手指是否已在画布上
      slot: -1,                   // 落点对应的槽位（-1 = 内孔/未知）
      cancel: false               // 已判为「滚动列表」→ 本次触摸放弃拖拽
    };
  },

  onLibDragMove(e) {
    if (!this.libDrag) return;
    if (this.libDrag.cancel) return;      // 本次触摸已判为「滚列表」，不再接管
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t) return;
    const dx = t.clientX - this.libDrag.x0;
    const dy = t.clientY - this.libDrag.y0;
    const ax = Math.abs(dx), ay = Math.abs(dy);

    /* ---------- 方向判定（只在首次越界时做一次，之后锁定） ---------- */
    if (!this._libDragged) {
      if (ax <= 10 && ay <= 10) return;                      // 死区：还算「点击」
      if (ay > ax) {                                         // 竖着划 → 交还给滚动
        this.libDrag.cancel = true;
        return;
      }
      this._libDragged = true;
      /* 锁定瞬间补取一次画布矩形：从按下到判定成立之间，列表/页面可能
         已经移动了几像素，沿用旧 rect 会让最终落点整体偏移。 */
      this.refreshCvRect();
      this.setData({ libDragging: true });                   // 锁列表与页面滚动
    }

    const over = this.pointInCanvas(t.clientX, t.clientY);

    /* 落点对应的槽位：拖到环上 → 可插入该处；落在内孔 → 只能排到末尾。
       ⚠️ 这就是「放手后珠子出现在错误位置」的关键：
          提前算出并**告知顾客会放到哪**，松手后结果与提示一致。 */
    let slot = -1;
    if (over && this.L && this.L.ok) {
      const p = this.canvasLocal(t.clientX, t.clientY);
      if (p) slot = C.slotFromPoint(this.L, p.x, p.y);
    }

    const changed = (over !== this.libDrag.over) || (slot !== this.libDrag.slot);
    const now = Date.now();
    /* 跟手浮层：touchmove 可达 60Hz，节流到 ~16ms，避免高频 setData 掉帧；
       但落点/进出画布这类「状态变化」必须立即生效，不能等节流窗口。 */
    if (now - this._ghostAt >= 16 || changed) {
      this._ghostAt = now;
      const patch = {
        ghostOn: true,
        ghostX: t.clientX,
        ghostY: t.clientY,
        ghostHex: this.libDrag.hex,
        ghostD: this.libDrag.d,
        ghostSize: this.libDrag.d * 2 + 16   // 8→32 10→36 12→40 14→44 px
      };
      if (changed) {
        this.libDrag.over = over;
        this.libDrag.slot = slot;
        patch.dragOverCanvas = over;
        patch.canvasTag = !over ? '拖到右侧手环上松手'
                        : slot >= 0 ? '松手插入此处'
                        : '松手加到末尾';
      }
      this.setData(patch);
      /* 落点指示是画布内容的一部分（不是 DOM），setData 刷不到它，
         必须显式重绘。只在状态变化时重绘，不跟着每一帧走。 */
      if (changed) this.render();
    }
  },

  onLibDragEnd(e) {
    const d = this.libDrag;
    const dragged = this._libDragged;
    this.libDrag = null;

    /* 复位浮层、高亮、滚动锁与提示语 */
    this.setData({
      ghostOn: false,
      dragOverCanvas: false,
      libDragging: false,
      canvasTag: '拖动重排 · 拖到别珠上互调'
    });

    /* 延迟复位 _libDragged：让紧随 touchend 可能补发的 tap 被 onTapLib 吞掉；
       若没有补发，300ms 后也会自动复位，不会影响下一次点击。 */
    setTimeout(() => { this._libDragged = false; }, 300);

    if (!d || !dragged || !d.over) return;   /* 未移动、或没落在画布上 → 不添加 */

    const dd = d.d || DEFAULT_D;

    /* 已点选某颗 → 拖入 = 替换它（与「加一颗」按钮同一套语义，不改变颗数） */
    if (this.sel >= 0 && this.sel < this.seq.length) {
      this.seq = C.replaceAt(this.seq, this.sel, d.id, dd);
      this.sel = -1;
      this.refresh();
      return;
    }

    /* 其余情况**按落点插入**：拖到环上哪一段，就插进那一段。
       换算与画布内拖动完全同源（同一份 this.L + slotFromPoint），
       只是这里用 touchend 的坐标。
       落在内孔 / 布局不可用 → 退回追加到末尾（宽容处理，不吞掉这次操作）。 */
    let at = -1;
    const raw = e ? this.clientPoint(e) : null;
    const p = raw ? this.canvasLocal(raw.x, raw.y) : null;
    if (p && this.L && this.L.ok) {
      const i = C.slotFromPoint(this.L, p.x, p.y);
      if (i >= 0) {
        /* 落点偏在最近那颗的顺时针侧 → 插到它后面；逆时针侧 → 插到它前面。
           这样新珠子出现的位置才真的贴着手指落点，而不是永远排在末尾。 */
        let delta = Math.atan2(p.y, p.x) - this.L.items[i].a;
        while (delta < -Math.PI) delta += Math.PI * 2;
        while (delta >  Math.PI) delta -= Math.PI * 2;
        at = delta > 0 ? i + 1 : i;
      }
    }
    this.seq = at >= 0 ? C.insertAt(this.seq, at, d.id, dd)
                       : C.addOne(this.seq, d.id, dd);
    this.refresh();
  },

  /* ==================================================================
   * 排列顺序条
   * ================================================================== */
  onTapSeq(e) {
    const i = +e.currentTarget.dataset.i;
    if (isNaN(i) || i < 0 || i >= this.seq.length) return;
    /* 再点已选中的 = 取消选中 */
    this.sel = (this.sel === i) ? -1 : i;
    this.refresh();
  },

  onLongPressSeq(e) {
    const i = +e.currentTarget.dataset.i;
    if (isNaN(i) || i < 0 || i >= this.seq.length) return;
    /* 阶段一先把删除做掉：确认后直接删这颗 */
    wx.showModal({
      title: '移除这颗珠子？',
      content: '第 ' + (i + 1) + ' 颗',
      success: (r) => {
        if (!r.confirm) return;
        this.seq = C.removeAt(this.seq, i);
        if (this.sel === i) this.sel = -1;
        else if (this.sel > i) this.sel--;
        this.refresh();
      }
    });
  },

  /* ==================================================================
   * 一键排布
   * ================================================================== */
  onOneKey(e) {
    const k = e.currentTarget.dataset.k;
    if (!this.seq.length) {
      wx.showToast({ title: '先配几颗珠子', icon: 'none' });
      return;
    }
    if (k === 'mirror') {
      /* ⚠️ 一键工具**只许重排，不许增删**。
         旧实现是「取前半镜像覆盖后半」，顾客配的 白 草莓 茶 青金 红 会变成
         白 草莓 茶 草莓 白 —— 青金和红被删掉，还凭空多出草莓和白。
         现在改成守恒重排：排不成回文就如实告诉顾客缺什么，绝不擅自动他的珠子。 */
      const out = C.mirrorSeq(this.seq);
      if (!out) {
        const lack = C.oddIds(this.seq)
          .map(o => (C.MAP[o.id] ? C.MAP[o.id].name : o.id) + ' ' + o.d + 'mm')
          .join('、');
        wx.showModal({
          title: '这套搭配排不成对称',
          content: '对称要求每一种珠子都成双成对。现在 ' + lack +
                   ' 是单数个，给它们各再加 1 颗就能对称了。',
          showCancel: false,
          confirmText: '知道了'
        });
        return;                      /* 不做任何改动 */
      }
      this.seq = out;
    }
    else if (k === 'grad') {
      /* 同样只重排：把顾客选的珠子按深浅排成连续色带。
         旧实现只取首尾两颗当端点、从全库色卡拉一条链铺满，
         中间的珠子会被换成顾客没选过的珠材；首尾同色时更是整串变一个颜色。 */
      this.seq = C.gradientSeq(this.seq);
    }
    else if (k === 'rand')  this.seq = C.randomPreset(this.targetOf()).seq;
    else if (k === 'fit')   this.seq = this.fillToWrist();
    else if (k === 'reset') this.seq = [];

    /* 这几个键位都会**改变序列结构**（重排/换批/增删），
       原先选中的那颗已失去意义，统一清掉，避免选中环落在别的珠子上。 */
    this.sel = -1;
    this.refresh();
  },

  /** 按腕围补满：保持当前配色循环填到建议颗数 */
  fillToWrist() {
    const d = this.avgD();
    const want = C.suggestCount(this.targetOf(), d);
    const out = [];
    for (let i = 0; i < want; i++) out.push({ id: this.seq[i % this.seq.length].id, d });
    return out;
  },

  /** 序列的平均珠径。空序列时返回默认档，供预设成品与补满使用 */
  avgD() {
    if (!this.seq.length) return DEFAULT_D;
    return this.seq.reduce((s, b) => s + b.d, 0) / this.seq.length;
  },

  /** 目标周长：弹力线 = 腕围 + 松紧；非弹性 = 掌围 + 余量 */
  targetOf() {
    const { wrist, ease, cord } = this.data;
    return cord === 'elastic' ? wrist + ease : wrist * C.PALM_RATIO + 5;
  },

  /* ==================================================================
   * 随机成品（C-18）
   * ================================================================== */
  onPreset() {
    this.loadPreset();
  },

  loadPreset() {
    /* ⚠️ 必须显式传 [DEFAULT_D]：不传的话 core 会随机抽珠径（甚至混搭），
       而「换一条成品」是店主的推荐搭配，规格应当统一在主力现货上。
       core 在只收到一档珠径时会跳过「混搭径」风格，不会出现名实不符。 */
    const r = C.randomPreset(this.targetOf(), null, [DEFAULT_D]);
    this.seq = r.seq;
    this.sel = -1;
    this.refresh();
    this.setData({
      presetHint: '当前成品：' + r.name + ' · ' + DEFAULT_D + 'mm · ' + this.seq.length + ' 颗'
    });
  },

  /* ==================================================================
   * 尺寸设置
   * ================================================================== */
  onWrist(e) {
    const v = +e.detail.value;
    this.setData({ wrist: v }, () => this.refresh());
  },

  onEase(e) {
    this.setData({ ease: +e.currentTarget.dataset.v }, () => this.refresh());
  },

  onCord(e) {
    this.setData({ cord: e.currentTarget.dataset.v }, () => this.refresh());
  },

  /* ==================================================================
   * 下单 —— 把当前配置固化成订单，落本机订单表，并交给推送通道
   *
   * ⚠️ 珠径由店主预设，故订单里没有「客户选的尺寸」这一项，
   *    只有店主的规格 + 客户自己的腕围/松紧/绳材。
   * ================================================================== */
  onMakeOrder() {
    if (this.seq.length < 3) {
      wx.showToast({ title: '至少 3 颗才能成环', icon: 'none' });
      return;
    }

    const cordLabel = (this.data.cordOptions.filter(o => o.value === this.data.cord)[0] || {}).label || this.data.cord;

    const order = Order.build({
      /* 珠子连同**单价**一起交给订单层 —— 价格必须来自 core，不在订单层重算 */
      beads: this.seq.map(b => {
        const m = C.MAP[b.id] || {};
        return {
          id: b.id,
          name: m.name || b.id,
          hex: m.hex || '#ccc',
          d: b.d,
          price: C.priceOf(b.id, b.d)
        };
      }),
      wrist: this.data.wrist,
      ease: this.data.ease,
      cord: this.data.cord,
      cordLabel: cordLabel,
      beadsCost: this.data.beadsCost,
      cordFee: this.data.cordFee,
      total: this.data.total
    });

    const saved = Order.save(order);
    const pushed = Order.push(order);

    this.setData({
      orderHint: '已生成订单 ' + order.no + ' · ' + order.count + ' 颗 · ¥' + order.total
    });

    /* 推送成功与否必须如实告知：未接后端时订单只在客人本机，
       若提示「已推送给店主」会让店主漏单。 */
    const tail = pushed.ok
      ? '已推送给店主，请等待确认。'
      : '已存入本机订单表，店主可在「订单管理」中查看。';
    wx.showModal({
      title: '订单已生成',
      content: '单号 ' + order.no + '\n金额 ¥' + order.total + '\n' + order.summary + '\n\n' + tail,
      confirmText: '查看订单',
      cancelText: '继续修改',
      success: (r) => {
        if (r.confirm) wx.navigateTo({ url: '/pages/orders/orders' });
      }
    });

    if (!saved.ok) console.warn('[水晶手串] 订单存入本机失败：' + saved.reason);
    if (!pushed.ok) console.warn('[水晶手串] 订单未推送：' + pushed.reason);
  },

  /* ==================================================================
   * 统一刷新：把 seq 同步到 data 并重算所有派生值
   * ================================================================== */
  refresh() {
    /* 排列顺序条快照 */
    const seqView = this.seq.map((b, i) => {
      const m = C.MAP[b.id];
      return {
        i,
        id: b.id,
        d: b.d,
        rpx: DOT_RPX[b.d] || 55,
        name: m ? m.name : b.id,
        hex: m ? m.hex : '#ccc',
        sel: this.sel === i
      };
    });

    /* 报价：颗数×单价 + 绳费，全部由 core 的 priceOf算，禁止在本文件里定价 */
    let beadsCost = 0;
    const bySize = {};
    for (const b of this.seq) {
      beadsCost += C.priceOf(b.id, b.d);
      bySize[b.d] = (bySize[b.d] || 0) + 1;
    }
    /* ⚠️ C.CORD_FEE 是**按绳型取值的对象** {elastic:2, wax:5}，不是数字。
       原型里是 C.CORD_FEE[cord]，写成 C.CORD_FEE 会得到 [object Object] 并算错钱。 */
    const cordFee = this.seq.length ? (C.CORD_FEE[this.data.cord] || 0) : 0;
    const total = beadsCost + cordFee;

    /* 尺寸判定 + 可执行建议
       判定条说「现在怎么样」，建议标签说「该怎么办」，两者同理据、必然自洽。 */
    const target = this.targetOf();
    let verdict = null, adviceLabel = '', adviceLevel = '', adviceAlt = '';

    if (this.seq.length) {
      const L = C.layout(this.seq);
      if (L.ok) {
        const stretch = C.stretchOf(L.innerPerim, this.data.wrist);
        verdict = C.fitVerdict(stretch, this.data.cord);
        /* 语义码由 core 判定，中文映射在 UI 层（ADVICE_LABEL） */
        const code = C.fitAdvice(stretch, L.n, C.suggestCount(target, L.avgD), this.data.cord);
        adviceLabel = ADVICE_LABEL[code] || '';
        adviceLevel = verdict.level;      // 建议标签沿用判定的配色
        /* 副建议：主建议走「改颗数」，副建议走「守住颗数、换珠径」。
           ⚠️ 只在 add/cut 时给 —— 主建议自己就是 bigger/smaller 时再给一遍是重复。
           珠径候选用 D_SIZES（店主可售规格），core 只负责试算能否落进健康带。 */
        if (code === 'add' || code === 'cut') {
          const alt = C.resizeAdvice(L.n, this.data.wrist, this.data.cord, L.avgD, D_SIZES);
          if (alt) adviceAlt = '或换 ' + alt.d + 'mm 珠';
        }
      }
    }

    /* 色带分段 */
    const bands = this.seq.length ? C.bandsOf(this.seq) : [];

    this.setData({
      seqView,
      seqCount: this.seq.length,
      beadsCost,
      cordFee,
      total,
      priceDetail: this.seq.length
        ? this.seq.length + ' 颗 · 珠材 ¥' + beadsCost + ' + 绳费 ¥' + cordFee +
          '\n按径：' + Object.entries(bySize).map(([k, v]) => k + '×' + v).join('　')
        : '尚未配置',
      verdict,
      adviceLabel,
      adviceLevel,
      adviceAlt,
      /* bandsOf 返回 {id, d, n}，**不含 hex** —— 色值要自己去 MAP 查，
         否则色带会渲染成一片空白。
         同时补一个 i 供 wx:key 用：bands 是对象数组，不能用 *this，
         而 "index" 并非官方保留字，写它会在控制台刷警告。 */
      bands: bands.map((b, i) => ({
        i: i,
        hex: (C.MAP[b.id] || {}).hex || '#ccc',
        name: (C.MAP[b.id] || {}).name || b.id,
        d: b.d,
        n: b.n
      })),
      bandHint: this.seq.length
        ? '共 ' + bands.length + ' 段，每种珠材占一整段'
        : '',
      /* 颗数 >= 3 才能成环，也才能下单 —— 按钮置灰的依据 */
      canOrder: this.seq.length >= 3,
      selIdx: this.sel
    });

    this.render();
  }
});