/* pages/index/index.js —— 首页（阶段一占位）
 * 正式版可扩展：门店位置、到店预约入口、热门搭配（从云数据库读取）。
 */
Page({
  data: {
    /* 阶段一先放三条示例搭配，验证跳转链路。
       正式版可从云数据库读取珠材与搭配数据。 */
    presets: [
      { key: 'grad', name: '白水晶渐变', desc: '由浅入深，最百搭' },
      { key: 'cold', name: '青金石素串', desc: '沉稳，适合男生' },
      { key: 'warm', name: '暖调三色', desc: '草莓晶 + 粉晶 + 黄水晶' }
    ]
  },

  onGoCustom() {
    wx.navigateTo({ url: '/pages/custom/custom' });
  }
});