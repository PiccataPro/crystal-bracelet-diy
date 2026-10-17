/* pages/orders/orders.js —— 店主侧：本机订单列表
 *
 * ⚠️ 这是「订单推送」的接收端（当前为**本机版**）。
 *    真实跨设备推送需要后端；utils/order-store.js 里已把通道抽成 PUSH_ENDPOINT。
 *    接入后端后，只需把下面的 reload() 换成从接口拉取，页面结构与样式都不用动。
 *
 * ⚠️ WXML 不能调用函数，所以所有派生文案（几颗 / 按径 / 腕围）都在这里预先算好。
 */

const Order = require('../../utils/order-store.js');

Page({
  data: {
    list: [],     // 订单快照（含预生成的派生文案）
    count: 0,
    amount: 0
  },

  /* 从定制页下单后返回、或从别处进来，都要看到最新数据 → 用 onShow 而不是 onLoad */
  onShow() {
    this.reload();
  },

  reload() {
    const raw = Order.list();
    const list = raw.map(o => {
      const beads = (o.beads || []).map((b, i) => ({
        i: i,                 // 给 wx:key 用（beads 是对象数组，不能 *this）
        id: b.id,
        name: b.name,
        hex: b.hex || '#ccc',
        d: b.d
      }));
      return {
        no: o.no,
        time: o.time,
        total: o.total,
        count: o.count,
        summary: o.summary,
        status: o.status,
        statusText: o.status === 'pending' ? '待确认' : (o.status === 'done' ? '已确认' : '已取消'),
        dimLine: o.count + ' 颗 · 按径 ' + o.dSummary,
        fitLine: '腕围 ' + o.wrist + 'mm ＋ 松紧 ' + o.ease + 'mm · ' + o.cordLabel,
        beads: beads
      };
    });

    this.setData({
      list: list,
      count: raw.length,
      amount: raw.reduce((s, o) => s + (o.total || 0), 0)
    });
  },

  onRemove(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    wx.showModal({
      title: '删除这条订单？',
      content: no,
      success: (r) => {
        if (!r.confirm) return;
        Order.remove(no);
        this.reload();
      }
    });
  },

  onClear() {
    if (!this.data.count) return;
    wx.showModal({
      title: '清空全部订单？',
      content: '共 ' + this.data.count + ' 单，清空后不可恢复',
      success: (r) => {
        if (!r.confirm) return;
        Order.clear();
        this.reload();
      }
    });
  }
});
