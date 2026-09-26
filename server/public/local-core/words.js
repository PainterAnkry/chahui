'use strict';

const P = require('./protocol');

/**
 * 你画我猜的词库。
 *
 * ⚠️ 只放在服务端，**绝不随前端下发** —— 一旦词库进了网页源码，
 * 任何人 F12 就能把全部答案看一遍，这游戏就废了。
 * 选词与判定都在服务端做，客户端只拿到「自己该看到的那个词」。
 *
 * 选词标准：能画、不歧义、不含敏感内容。
 * 长度 1~12 个字符都收（中文 / 英文 / 数字）—— 单字词也能出，只是不给露字提示。
 *
 * 想换成自己人爱画的词（同事名、项目梗、方言…）：
 * 起服务端时给一个环境变量即可 ——
 *   CHAHU_WORDS='长颈鹿,珍珠奶茶,加班,堵车' node server/src/index.js
 * 自动化测试也靠它把答案固定成长词，否则「露字提示」这类断言会因为
 * 随机抽到两字词而变成随机失败。
 */

const DEFAULT_WORDS = [
  // ---- 动物 ----
  '猫咪', '小狗', '大象', '长颈鹿', '企鹅', '熊猫', '蝴蝶', '螃蟹', '章鱼', '乌龟',
  '兔子', '老虎', '狮子', '猴子', '鲸鱼', '鲨鱼', '孔雀', '刺猬', '松鼠', '青蛙',
  '蜗牛', '蜜蜂', '蝙蝠', '骆驼', '犀牛', '鳄鱼', '海豚', '猫头鹰', '公鸡', '小猪',
  '金鱼', '蜘蛛', '恐龙', '狐狸', '袋鼠',

  // ---- 食物 ----
  '西瓜', '草莓', '汉堡', '披萨', '冰淇淋', '面条', '饺子', '蛋糕', '咖啡', '寿司',
  '火锅', '棒棒糖', '爆米花', '甜甜圈', '三明治', '糖葫芦', '珍珠奶茶', '煎蛋', '玉米',
  '菠萝', '葡萄', '包子', '玉米须茶', '泡面', '月饼',

  // ---- 物品 ----
  '雨伞', '眼镜', '手表', '吉他', '相机', '自行车', '火箭', '灯泡', '钥匙', '剪刀',
  '风筝', '沙漏', '望远镜', '麦克风', '篮球', '钢琴', '电风扇', '冰箱', '洗衣机',
  '牙膏', '牙刷', '书包', '铅笔', '橡皮', '图钉', '螺丝刀', '放大镜', '口罩',
  '水壶', '闹钟', '雨衣', '地球仪', '飞机', '热气球', '风筝线',

  // ---- 自然 ----
  '太阳', '月亮', '星星', '彩虹', '闪电', '龙卷风', '雪人', '火山', '瀑布',
  '仙人掌', '向日葵', '蘑菇', '枫叶', '沙滩', '流星', '云朵', '落叶', '海浪',

  // ---- 地点 / 建筑 ----
  '灯塔', '城堡', '金字塔', '摩天轮', '风车', '帐篷', '秋千', '滑梯', '天桥',
  '斑马线', '地铁站', '喷泉', '小木屋',

  // ---- 动作 / 情景 ----
  '睡觉', '跑步', '游泳', '弹吉他', '打电话', '打喷嚏', '拍照', '跳绳', '钓鱼',
  '爬山', '刷牙', '洗脸', '跳舞', '唱歌', '大哭', '大笑', '生气', '摔倒',
  '拥抱', '握手', '打伞', '排队', '堵车', '加班', '考试', '下雨天', '生日快乐',
  '海底世界', '太空漫步', '拯救世界', '时间旅行', '熬夜', '堵在路上'
];

/**
 * 自定义词库：环境变量 CHAHU_WORDS，逗号 / 顿号 / 空格 / 换行分隔。
 * 少于 3 个词就当没给（候选词要 3 个才有得选，词太少游戏没法玩）。
 */
function customWords() {
  const raw = process.env.CHAHU_WORDS;
  if (!raw) return null;
  const list = raw.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
  return list.length >= 3 ? list : null;
}

const WORDS = customWords() || DEFAULT_WORDS;

/**
 * 词库自检：词必须是「能玩的词」（中文 / 英文 / 数字，1 ~ 12 个字符，不带空格标点）。
 *
 * 规则本身在 shared/protocol.js 的 isPlayableWord() 里 —— 词库、写词校验、
 * 主题管理前端共用同一份，免得三处各写一个正则、改一处漏两处。
 *
 * ⚠ 单字词以前是**硬错误**，现在放开了（用户要求「可英文和一个字」）。
 *   当初拦它的两个理由都已经在别处解决：
 *     ① 「露字提示」露一个等于给答案 —— HINT_MIN_LEN = 3，1 字与 2 字都不给提示；
 *     ② 「很接近了」误报 —— isNearGuess 里 `w.length < 2 → false` 已经挡掉。
 *   所以这里只需要保证「不是空白、不含空格标点、不太长」。
 */
{
  const bad = WORDS.filter(w => !P.isPlayableWord(w));
  if (bad.length) throw new Error('词库里有不合格的词（非空、不带空白、1~12 个字符、至少一个实义字符）：' + bad.join('、'));
}

/** 已经用过的词不重复出；库见底了就允许重复（总比开不了局强） */
function pickChoices(n, used, pool) {
  const base = pool || WORDS;
  const usedSet = new Set(used || []);
  let avail = base.filter(w => !usedSet.has(w));
  if (avail.length < n) avail = base.slice();          // 词用光了，重新洗一轮
  const out = [];
  const copy = avail.slice();
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

function size() { return WORDS.length; }

/**
 * 按主题取词池。
 *   default / 未知 / 混合题库里没有的词 → 通用词库
 *   有主题 → 主题词库（见 themes.js）
 * 注意：`CHAHU_WORDS` 自定义词库**优先级最高** —— 测试靠它把答案固定住，
 * 如果被主题词库盖掉，所有依赖固定答案的断言都会随机失败。
 */
function poolForTheme(themeId) {
  if (customWords()) return WORDS;                 // 自定义词库压过一切主题
  const themed = require('./themes').wordsOf(themeId);
  return themed || WORDS;
}

/** 自定义词库是否生效（/api/share 的自检字段要如实报告这件事） */
function isCustom() { return !!customWords(); }

module.exports = { WORDS, pickChoices, size, poolForTheme, isCustom };
