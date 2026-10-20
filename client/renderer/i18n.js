/* 茶绘 · 多语言（简体中文 / English / 日本語）
 *
 * 设计取舍：界面文案在十来万行代码里散落成几千个中文字面量，逐个改成 t('key')
 * 既容易漏、又会把 diff 变成灾难。这里用「源文案作 key」的运行期翻译层：
 *   · 字典 i18n-dict.js：{ '中文原文': ['English', '日本語'] }
 *   · 文本节点 / title、placeholder、aria-label、alt 属性按「整串」查表替换
 *   · MutationObserver 跟着 DOM 变化继续翻（弹窗、toast、动态计数都能覆盖）
 *   · 没收录的串原样保留（回退中文），不会出现空白或 key 泄漏
 *   · 切回中文时从每个节点上记住的原文恢复，不做反向查表
 *
 * 动态文案（带数字/名字的）用 RULES 里的正则处理，比给每个组合建 key 靠谱。
 */
(function () {
  'use strict';

  var LS_LANG = 'chahu.lang';
  var LANGS = ['zh', 'en', 'ja'];
  var IDX = { zh: -1, en: 0, ja: 1 };

  var lang = 'zh';
  try {
    var saved = localStorage.getItem(LS_LANG);
    if (saved && LANGS.indexOf(saved) >= 0) lang = saved;
  } catch (e) { /* ignore */ }

  function dict() { return (typeof window !== 'undefined' && window.ChaI18nDict) || {}; }

  /** 动态文案规则：[正则, 英文, 日文]（可用 $1 引用捕获组） */
  var RULES = [
    // 版本 / 房间状态 / 计数
    [/^版本 (.+)$/, 'Version $1', 'バージョン $1'],
    [/^在线 (\d+) 人$/, '$1 online', 'オンライン $1 人'],
    [/^离线$/, 'Offline', 'オフライン'],
    [/^共 (\d+) 笔$/, '$1 strokes', '全 $1 ストローク'],
    [/^共 (\d+) 笔 · 我的撤销栈 (\d+)$/, '$1 strokes · my undo stack: $2', '全 $1 ストローク・自分のアンドゥ $2'],
    [/^我的撤销栈 (\d+)$/, 'my undo stack: $1', '自分のアンドゥ $1'],
    // 笔刷 tip 尾巴上拼的「参数取自 SAI2 笔刷包「X」」放在 decompose 里处理
    // （X 是包里的笔刷名，得递归翻，规则里没法调 t()）
    // 连接状态（地址是动态的，只能靠规则）
    [/^已连接 (.+)$/, 'Connected $1', '接続済み $1'],
    [/^未连接$/, 'Not connected', '未接続'],
    [/^连接中$/, 'Connecting', '接続中'],
    [/^离线模式$/, 'Offline mode', 'オフラインモード'],
    [/^已断开$/, 'Disconnected', '切断されました'],
    [/^连接断开，正在重连…$/, 'Connection lost, reconnecting…', '接続が切れました。再接続中…'],
    [/^已重连，正在回到「(.+)」…$/, 'Reconnected, returning to "$1"…', '再接続しました。「$1」に戻っています…'],
    [/^画布同步完成$/, 'Canvas synced', 'キャンバス同期完了'],
    [/^画布同步完成 · 共 (\d+) 笔$/, 'Canvas synced · $1 strokes', 'キャンバス同期完了・全 $1 ストローク'],
    [/^(.+) 进入了茶绘室$/, '$1 joined the room', '$1 が入室しました'],
    [/^(.+) 离开了茶绘室$/, '$1 left the room', '$1 が退室しました'],
    [/^已进入「(.+)」$/, 'Joined "$1"', '「$1」に入室しました'],
    [/^(.+)（空 (\d+)）$/, '$1 ($2 empty)', '$1（空き $2）'],
    [/^(\d+) 人份$/, '$1 servings', '$1 人分'],
    [/^已选 (\d+) 支$/, 'Selected: $1', '$1 個選択中'],
    [/^已选 (\d+) 个$/, 'Selected: $1', '$1 個選択中'],
    [/^第 (\d+) 人$/, 'Player $1', '$1 人目'],
    [/^第 (\d+) 步$/, 'Step $1', 'ステップ $1'],
    [/^(\d+) 人$/, '$1 player(s)', '$1 人'],
    [/^(\d+) 支$/, '$1 brush(es)', '$1 本'],
    [/^(\d+) 支笔刷$/, '$1 brushes', '$1 本のブラシ'],
    [/^(\d+) 个图层$/, '$1 layers', '$1 レイヤー'],
    [/^(\d+) 层$/, '$1 layers', '$1 レイヤー'],
    [/^(\d+) 笔$/, '$1 strokes', '$1 ストローク'],
    [/^(\d+) 字$/, '$1 chars', '$1 文字'],
    [/^(\d+) 毫秒$/, '$1 ms', '$1 ミリ秒'],
    [/^(\d+) 秒$/, '$1 s', '$1 秒'],
    [/^(\d+) 分钟$/, '$1 min', '$1 分'],
    [/^(\d+) 分钟前$/, '$1 min ago', '$1 分前'],
    [/^(\d+) 秒前$/, '$1 s ago', '$1 秒前'],
    [/^(\d+) 小时前$/, '$1 h ago', '$1 時間前'],
    [/^(\d+) 天前$/, '$1 d ago', '$1 日前'],
    [/^(\d+) 张$/, '$1', '$1 枚'],
    [/^(\d+) 次$/, '$1 time(s)', '$1 回'],
    [/^(\d+) 项$/, '$1 items', '$1 項目'],
    [/^(\d+) 条$/, '$1', '$1 件'],
    [/^(\d+) 格$/, '$1 cells', '$1 マス'],
    [/^(\d+) 关$/, 'Level $1', 'レベル $1'],
    [/^(\d+) 到 (\d+)$/, '$1–$2', '$1〜$2'],
    [/^(\d+) × (\d+)$/, '$1 × $2', '$1 × $2'],
    [/^([\d.]+)%$/, '$1%', '$1%'],
    // 交互里的固定组合（数字/名字由调用方拼在前面的，规则只兜住整句）
    [/^已导入 (\d+) 支笔刷，排在「笔刷栏」最后$/, 'Imported $1 brush(es), appended to the brush bar', '$1 本のブラシを読み込みました（ブラシバーの末尾）'],
    [/^已删除 (\d+) 支导入笔刷$/, 'Deleted $1 imported brush(es)', '読み込んだブラシを $1 本削除しました'],
    [/^删除 (\d+) 支导入的笔刷？$/, 'Delete $1 imported brush(es)?', '読み込んだブラシ $1 本を削除しますか？'],
    [/^外框 (\d+) 格$/, 'Outline $1 cells', '外枠 $1 マス'],
    [/^已复制到第 (\d+) 帧$/, 'Copied to frame $1', 'フレーム $1 にコピーしました'],
    [/^共 (\d+) 页$/, '$1 pages', '全 $1 ページ'],
    [/^(\d+) \/ (\d+)$/, '$1 / $2', '$1 / $2'],
    [/^剩余 (\d+) 秒$/, '$1 s left', '残り $1 秒'],
    [/^倒计时 (\d+) 秒$/, 'Countdown: $1 s', 'カウントダウン $1 秒'],
    [/^第 (\d+) 格$/, 'Panel $1', '$1 コマ目'],
    [/^第 (\d+) 轮$/, 'Round $1', '第 $1 ラウンド'],
    [/^(\d+) 回合$/, '$1 round(s)', '$1 ラウンド'],
    [/^(\d+) 轮$/, '$1 round(s)', '$1 周'],
    [/^(\d+) 手$/, '$1 pass(es)', '$1 手'],
    [/^([\d.]+)x$/, '$1x', '$1x'],
    [/^([\d.]+)x（默认）$/, '$1x (default)', '$1x（デフォルト）'],
    // 聊天表情 / 色板 / 快捷笔刷：「发送 😀」「#fff（点一下就用它）」「铅笔（点一下就换，长按弹笔刷库）」
    [/^发送 (.+)$/, 'Send $1', '「$1」を送信'],
    [/^(#[0-9a-fA-F]{3,8})（点一下就用它）$/, '$1 (click to use)', '$1（クリックで使用）'],
    [/^(.+)（点一下就换，长按弹笔刷库）$/, '$1 (tap to switch, long-press for the brush library)', '$1（タップで切替、長押しでブラシ一覧）']
  ];

  /** 键位名（只处理中文的那几个，字母/符号原样） */
  function keyName(k) {
    if (k === '空格') return lang === 'en' ? 'Space' : 'スペース';
    if (k === '回车') return lang === 'en' ? 'Enter' : 'Enter';
    return k;
  }

  /** 组合式文案：xxx（默认）/ 默认（80 秒）/ 还差 1 人 / 当前 1 人在线（…） */
  function decompose(src) {
    var i2 = IDX[lang];
    var en = i2 === 0;

    // 「名称（快捷键 K）｜说明」——笔刷/工具格的 title 是 name + 键位 + tip 拼出来的，
    // 整串查不到表，只能按结构拆开各自翻（tip 里还可能带「·」分段，交给 t() 递归）。
    var mk = /^([^｜]+?)（快捷键 ([^）]+)）｜([\s\S]*)$/.exec(src);
    if (mk) {
      return t(mk[1]) + (en ? ' (' : '（') + keyName(mk[2]) + (en ? ') — ' : '）｜') + t(mk[3]);
    }
    var mw = /^([^｜]+?)｜([\s\S]*)$/.exec(src);
    if (mw) {
      var l = t(mw[1]), r = t(mw[2]);
      if (l !== mw[1] || r !== mw[2]) return l + (en ? ' — ' : '｜') + r;
    }

    var SUF = [
      ['（默认）', ' (default)', '（デフォルト）'],
      ['（导入）', ' (imported)', '（読み込み）'],
      ['（我）', ' (me)', '（自分）'],
      ['（空）', ' (empty)', '（空）']
    ];
    for (var s = 0; s < SUF.length; s++) {
      var suf = SUF[s][0];
      if (src.length > suf.length && src.slice(-suf.length) === suf) {
        var inner = src.slice(0, -suf.length);
        var ti = t(inner);
        if (ti !== inner) return ti + SUF[s][i2 === 0 ? 1 : 2];
      }
    }
    var m = /^默认（(.+)）$/.exec(src);
    if (m) {
      var v = t(m[1]);
      return i2 === 0 ? 'Default (' + v + ')' : 'デフォルト（' + v + '）';
    }
    m = /^还差 (\d+) 人$/.exec(src);
    if (m) return i2 === 0 ? m[1] + ' more player(s) needed' : 'あと ' + m[1] + ' 人';
    m = /^当前 (\d+) 人在线（你画我猜需要 (\d+) ~ (\d+) 人）$/.exec(src);
    if (m) {
      return i2 === 0
        ? m[1] + ' player(s) online (Draw & Guess needs ' + m[2] + '–' + m[3] + ')'
        : '現在 ' + m[1] + ' 人在線（お絵かき当ては ' + m[2] + '〜' + m[3] + ' 人）';
    }

    // 快捷笔刷 chip：「铅笔（点一下就换，长按弹笔刷库）」—— 前缀是笔刷名，要递归翻
    m = /^(.+?)（点一下就换，长按弹笔刷库）$/.exec(src);
    if (m) {
      return t(m[1]) + (en ? ' (tap to switch, long-press for the brush library)'
        : '（タップで切替、長押しでブラシ一覧）');
    }
    // 游戏音效按钮的三个状态
    m = /^游戏音效：关（点击开启）$/.exec(src);
    if (m) return en ? 'Game sound: off (click to turn on)' : 'ゲーム効果音：オフ（クリックでオン）';
    m = /^游戏音效：开，但音量是 0（拖右边滑块调大）$/.exec(src);
    if (m) return en ? 'Game sound: on but volume is 0 (drag the slider on the right)'
      : 'ゲーム効果音：オン、ただし音量 0（右のスライダーで上げてください）';
    m = /^游戏音效：开（音量 (\d+)%）· 点一下静音$/.exec(src);
    if (m) return en ? 'Game sound: on (volume ' + m[1] + '%) · click to mute'
      : 'ゲーム効果音：オン（音量 ' + m[1] + '%）・クリックでミュート';

    // 「别人的笔迹在本机显示得多清楚：<档位说明>（只影响…）」
    m = /^别人的笔迹在本机显示得多清楚：([\s\S]+)（只影响你自己的屏幕 —— 不影响导出，也不会同步给别人）$/.exec(src);
    if (m) {
      return en
        ? "How clearly others' strokes show on this screen: " + t(m[1])
          + ' (affects only your own screen — not exports, and not synced to others)'
        : '他人の筆跡をこの画面でどれだけはっきり表示するか：' + t(m[1])
          + '（自分の画面だけに影響 —— 書き出しにも他人への同期にも影響しません）';
    }

    // 「参数取自 / 来自 SAI2 笔刷包「X」」—— 包里的笔刷名要一起翻，所以放在能递归的位置
    m = /^(?:参数取自|来自) SAI2 笔刷包「(.+)」$/.exec(src);
    if (m) return (en ? 'From the SAI2 brush pack “' : 'SAI2 ブラシパック「') + t(m[1]) + (en ? '”' : '」より');

    // 「放大 (=)」「缩小 (-)」这类「中文名 (键位)」——英文括号，键位原样保留
    m = /^(.+?) \(([^)]{1,8})\)$/.exec(src);
    if (m) {
      var nm = t(m[1]);
      if (nm !== m[1]) return nm + ' (' + m[2] + ')';
    }
    return null;
  }

  /** 按正则规则翻一条（没命中返回 null） */
  function applyRules(src) {
    for (var i = 0; i < RULES.length; i++) {
      var m = RULES[i][0].exec(src);
      if (m) {
        var out = RULES[i][IDX[lang] === 0 ? 1 : 2];
        for (var g = m.length - 1; g >= 1; g--) out = out.replace(new RegExp('\\$' + g, 'g'), m[g]);
        return out;
      }
    }
    return null;
  }

  /** 翻译一条源文案 */
  function t(src) {
    if (src == null) return src;
    if (lang === 'zh') return src;
    var d = dict();
    var hit = d[src];
    if (hit && hit[IDX[lang]]) return hit[IDX[lang]];
    var dec = decompose(src);
    if (dec != null) return dec;
    var r = applyRules(src);
    if (r != null) return r;
    // 片段回退（两段式）：
    //   ① 先只按「·」这类弱分隔符切 —— 「SAI2 铅笔：硬边… · 参数取自…」两半各自都是完整句子，
    //      整句查不到表，切一半就都能命中；
    //   ② 还不行再按「：」「，」切，处理「名称：说明」这种标签-值结构。
    // 只在至少一段真的翻出来时才重组，避免把句子拆坏。
    var SEP1 = /\s[·・|]\s/;
    if (SEP1.test(src)) {
      var o1 = tryParts(src, SEP1);
      if (o1 != null) return o1;
    }
    if (/：|，/.test(src)) {
      var o2 = tryParts(src, /(：|，)/);
      if (o2 != null) return o2;
    }
    return src;   // 回退：原样（中文）
  }

  /** 按分隔符拆段、逐段查表（分隔符原样保留）；一段都没翻出来时返回 null */
  function tryParts(src, sepRe) {
    var d = dict(), ix = IDX[lang];
    var parts = src.split(new RegExp('(' + sepRe.source + ')'));
    var changed = false, out = '';
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      if (!p) continue;
      if (!hasHan(p)) { out += p; continue; }
      var hp = d[p];
      if (hp && hp[ix]) { out += hp[ix]; changed = true; continue; }
      // 分段自己也可能是一条「组合句」（比如「参数取自 SAI2 笔刷包「画笔」」里还套着笔刷名），
      // 所以规则和组合规则都要再试一遍 —— 否则只能翻到「一半中文一半英文」。
      var dp = decompose(p);
      if (dp != null && dp !== p) { out += dp; changed = true; continue; }
      var rp = applyRules(p);
      if (rp != null && rp !== p) { out += rp; changed = true; continue; }
      out += p;
    }
    return changed ? out : null;
  }

  // 元素整体跳过（改它们的内容没有意义/会坏）
  var SKIP_EL = { SCRIPT: 1, STYLE: 1, CANVAS: 1, SVG: 1 };
  // 只跳过文本、但属性照翻（textarea 里的 placeholder 就是中文，内容却是用户输入）
  var SKIP_TEXT_EL = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, CANVAS: 1, SVG: 1 };
  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  function hasHan(s) { return /[\u4e00-\u9fff]/.test(s); }

  /** 标记了 data-i18n-skip 的子树整段不翻译（语言开关、代码示例等） */
  function inSkip(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('[data-i18n-skip]');
  }

  function localizeText(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var pe = node.parentElement;
    if (!pe || SKIP_TEXT_EL[pe.tagName] || inSkip(pe)) return;
    var lead = raw.match(/^\s*/)[0], tail = raw.match(/\s*$/)[0];
    var core = raw.slice(lead.length, raw.length - tail.length);
    if (!core) return;
    // ⚠ 只有「不是我们自己写进去的译文」才算新的中文源。
    //   日文里全是汉字，切回中文时如果按 hasHan 认源，就会把「書き出し」当成原文存下来，
    //   于是回中文后按钮上留着日文（实测过）。
    if (core !== node.__out && hasHan(core)) node.__src = core;
    if (!node.__src) return;
    var out = lang === 'zh' ? node.__src : t(node.__src);
    if (out === core) return;
    node.nodeValue = lead + out + tail;
    node.__out = out;
  }

  function localizeAttr(el, name) {
    var cur = el.getAttribute(name);
    if (cur == null) return;
    var outs = el.__i18nOut;
    if (!(outs && outs[name] === cur) && hasHan(cur)) {
      el.__i18n = el.__i18n || {};
      el.__i18n[name] = cur;
    }
    var src = el.__i18n && el.__i18n[name];
    if (!src) return;
    var out = lang === 'zh' ? src : t(src);
    if (out === cur) return;
    el.setAttribute(name, out);
    el.__i18nOut = el.__i18nOut || {};
    el.__i18nOut[name] = out;
  }

  function localizeEl(el) {
    if (!el || el.nodeType !== 1) return;
    if (SKIP_EL[el.tagName]) return;
    if (el.hasAttribute && el.hasAttribute('data-i18n-skip')) return;
    for (var i = 0; i < ATTRS.length; i++) localizeAttr(el, ATTRS[i]);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { localizeText(root); return; }
    if (root.nodeType !== 1) return;
    localizeEl(root);
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) localizeText(n);
      else localizeEl(n);
    }
  }

  var pending = null, scheduled = false;
  function schedule(root) {
    if (!pending) pending = new Set();
    if (root) pending.add(root);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      var roots = pending ? Array.from(pending) : [];
      pending = null;
      roots.forEach(function (r) { try { walk(r); } catch (e) { /* ignore */ } });
    });
  }

  function observe() {
    if (!window.MutationObserver || !document.body) return;
    var mo = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (r.type === 'characterData') { if (r.target) schedule(r.target.parentNode); }
        else if (r.type === 'attributes') { if (r.target) schedule(r.target); }
        else if (r.addedNodes && r.addedNodes.length) {
          for (var k = 0; k < r.addedNodes.length; k++) {
            var nd = r.addedNodes[k];
            if (nd.nodeType === 1 || nd.nodeType === 3) schedule(nd);
          }
        }
      }
    });
    mo.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  function setLang(next) {
    if (LANGS.indexOf(next) < 0) next = 'zh';
    lang = next;
    try { localStorage.setItem(LS_LANG, next); } catch (e) { /* ignore */ }
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : (next === 'ja' ? 'ja' : 'en');
    document.documentElement.setAttribute('data-lang', next);
    // 整页重扫：中文→外语走查表，外语→中文走节点上记的原文
    walk(document.documentElement);
    // 语言切换控件自身的选中态
    var btns = document.querySelectorAll('#langSwitch [data-lang]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-lang') === next);
    }
    try {
      window.dispatchEvent(new CustomEvent('chahu:lang', { detail: { lang: next } }));
    } catch (e) { /* ignore */ }
    return next;
  }

  /**
   * 整段 HTML 文案（用户准则、风险须知这类长文）。
   * 长文里混着 <b>/<code>/<a>，逐文本节点翻会把句子切成碎片、各语言语序也不对，
   * 所以按「整块」查表 —— key 由调用方给（如 'about.terms'），避免拿整段 HTML 当 key
   * 那种又长又容易对不上的写法。
   */
  function htmlOf(src, key) {
    if (src == null) return src;
    if (lang === 'zh') return src;
    var d = dict();
    var hit = key ? d[key] : d[src];
    if (!hit) hit = d[src];
    return (hit && hit[IDX[lang]]) || src;
  }

  window.ChaI18n = {
    get lang() { return lang; },
    LANGS: LANGS,
    setLang: setLang,
    t: t,
    html: htmlOf,
    apply: walk,
    schedule: schedule,
    hasHan: hasHan
  };

  function boot() {
    // 先按语言写好 html 属性，避免首屏中文闪一下再变英文
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    document.documentElement.setAttribute('data-lang', lang);
    var btns = document.querySelectorAll('#langSwitch [data-lang]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-lang') === lang;
      btns[i].classList.toggle('on', on);
      btns[i].addEventListener('click', function () { setLang(this.getAttribute('data-lang')); });
    }
    if (lang !== 'zh') walk(document.documentElement);
    observe();
    // 首屏之后 app.js 会继续插节点，观察器已经就位；这里再兜一次启动期渲染
    setTimeout(function () { if (lang !== 'zh') walk(document.documentElement); }, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
