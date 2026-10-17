/* utils/order-store.js —— 订单：构建 / 本地存取 / 推送通道
 *
 * ⚠️ 分层纪律：本模块**零算法**，不认识手串几何，也不定价。
 *    它只做一件事：把调用方已经算好的一条配置（珠子、尺寸、金额）固化成订单快照，
 *    然后落盘 / 推送。定价与尺寸仍由 bracelet-core.js 唯一负责。
 *
 * ⚠️ 关于「推送给店主」：
 *    真正的跨设备推送需要一个后端（或云开发）。本文件把这件事抽成 push()，
 *    并把通道留成可配置的 PUSH_ENDPOINT —— 未配置时**明确返回 ok:false**，
 *    绝不假装推送成功（假成功会让店主漏单）。
 *    接入方式确定后，只需填 PUSH_ENDPOINT，调用方代码一行都不用改。
 */
'use strict';

/* 本地订单表在 storage 里的键名。改名等于弃掉历史订单，谨慎。 */
const KEY = 'MB_ORDERS_V1';

/* 推送通道地址。
 *   现在为 ''（未接入）→ push() 返回 ok:false，订单只落本机。
 *   接入后填后端地址，例如 'https://your-host/api/orders'。
 *   ⚠️ 微信要求请求域名在小程序后台「开发设置 → 服务器域名」里白名单化；
 *      游客/无 AppID 模式下域名校验会被跳过，但正式发布必须配置。 */
const PUSH_ENDPOINT = '';

/* 无 storage 环境（Node 单元测试）下的内存兜底，保证逻辑可测。 */
let MEM = [];

/* ======================================================================
 * 时间与单号
 * ==================================================================== */
function pad(n, w) {
  let s = '' + n;
  while (s.length < (w || 2)) s = '0' + s;
  return s;
}

/** 单号：MB + yyyyMMddHHmmss + '-' + 4 位随机，便于口头核对 */
function makeNo(now) {
  const d = now ? new Date(now) : new Date();
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
                pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return 'MB' + stamp + '-' + pad(Math.floor(Math.random() * 10000), 4);
}

/** 可读时间 yyyy-MM-dd HH:mm */
function makeTime(now) {
  const d = now ? new Date(now) : new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
         ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* ======================================================================
 * 存储读写（带兜底：拿不到 wx.storage 时退回内存，不影响主流程）
 * ==================================================================== */
function api() {
  try {
    if (typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function') return wx;
  } catch (e) { /* wx 不存在（Node 测试）→ 走内存 */ }
  return null;
}

function readAll() {
  const a = api();
  let v;
  if (a) {
    try { v = a.getStorageSync(KEY); } catch (e) { v = null; }
  } else {
    v = MEM;
  }
  if (!v) return [];
  if (Array.isArray(v)) return v;
  /* 部分环境会把值以字符串回吐，兼容一下 */
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch (e) { return []; }
  }
  return [];
}

function writeAll(list) {
  const a = api();
  if (a && typeof a.setStorageSync === 'function') {
    try {
      a.setStorageSync(KEY, list);
      return list;
    } catch (e) { /* 落盘失败（超配额等）→ 退回内存，至少本次会话可见 */ }
  }
  MEM = list;
  return list;
}

/* ======================================================================
 * 对外接口
 * ==================================================================== */

/**
 * 构建订单快照。
 *
 * @param {object} o
 *   o.beads     [{id,name,hex,d,price}]  每颗珠子（**含单价**，由调用方从 core 取）
 *   o.wrist     腕围 mm
 *   o.ease      松紧余量 mm
 *   o.cord      绳型 key
 *   o.cordLabel 绳型显示名
 *   o.beadsCost / o.cordFee / o.total  金额（由 core 算好传入，本模块不重算）
 * @returns {object} 订单
 */
function build(o) {
  const src = (o && o.beads) || [];
  const beads = src.map(b => ({
    id: b.id, name: b.name, hex: b.hex, d: b.d, price: b.price
  }));

  /* 按珠径归并颗数（纯数据整理，不是算法） */
  const bySize = {};
  for (const b of beads) bySize[b.d] = (bySize[b.d] || 0) + 1;
  const dSummary = Object.keys(bySize)
    .map(Number).sort((a, b) => a - b)
    .map(d => d + '×' + bySize[d]).join(' ');

  const count = beads.length;
  const total = o && o.total || 0;
  const beadsCost = o && o.beadsCost || 0;
  const cordFee = o && o.cordFee || 0;

  return {
    no: makeNo(o && o.now),
    ts: o && o.now ? o.now : Date.now(),
    time: makeTime(o && o.now),
    count: count,
    beads: beads,
    dSummary: dSummary,
    /* 一行摘要，便于在列表页与消息里直接展示（WXML 不支持函数调用，必须预生成） */
    summary: count + ' 颗 · 珠材 ¥' + beadsCost + ' + 绳费 ¥' + cordFee + ' · 按径 ' + dSummary,
    wrist: o && o.wrist,
    ease: o && o.ease,
    cord: o && o.cord,
    cordLabel: o && o.cordLabel || '',
    beadsCost: beadsCost,
    cordFee: cordFee,
    total: total,
    status: 'pending',       /* pending 待店主确认 → done 已确认 → cancelled 已取消 */
    statusText: '待确认'
  };
}

/** 存入本机订单表（最新在前）。返回 {ok, no, count} —— count 是表内总单数 */
function save(order) {
  if (!order || !order.no) return { ok: false, reason: '订单缺少单号' };
  const list = readAll();
  list.unshift(order);
  writeAll(list);
  return { ok: true, no: order.no, count: list.length };
}

/** 全部订单（最新在前） */
function list() {
  return readAll();
}

/** 按单号取一条 */
function get(no) {
  return readAll().filter(o => o.no === no)[0] || null;
}

/** 删掉一条 */
function remove(no) {
  const before = readAll();
  const after = before.filter(o => o.no !== no);
  writeAll(after);
  return before.length - after.length;
}

/** 清空本机订单表 */
function clear() {
  writeAll([]);
  return true;
}

/**
 * 推送给店主。
 *
 * ⚠️ 未配置 PUSH_ENDPOINT 时**必须返回 ok:false**：
 *    订单此刻只在客人手机上，店主是收不到的。调用方据此给出诚实的提示，
 *    而不是显示「已推送给店主」造成漏单。
 *
 * @returns {{ok:boolean, reason?:string, endpoint?:string}}
 */
function push(order) {
  if (!PUSH_ENDPOINT) {
    return { ok: false, reason: 'PUSH_ENDPOINT 未配置，订单只落本机订单表' };
  }
  try {
    wx.request({
      url: PUSH_ENDPOINT,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: order,
      success(res) {
        if (!res || res.statusCode >= 300) {
          console.warn('[订单] 推送失败，HTTP ' + (res && res.statusCode));
        }
      },
      fail(err) {
        console.warn('[订单] 推送异常：' + (err && err.errMsg));
      }
    });
    return { ok: true, endpoint: PUSH_ENDPOINT };
  } catch (e) {
    return { ok: false, reason: 'wx.request 调用失败：' + e.message };
  }
}

module.exports = {
  KEY, PUSH_ENDPOINT,
  makeNo, makeTime,
  build, save, list, get, remove, clear, push,
  /* 仅供测试：重置内存兜底 */
  _resetMem() { MEM = []; }
};
