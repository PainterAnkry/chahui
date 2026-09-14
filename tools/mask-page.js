/**
 * 截图脱敏：把页面上的真实公网地址与本机内网 IP 换成占位符。
 *
 * 为什么需要它：验收截图经常被拿去做展示、发进 README、贴进 issue，
 * 而页面上会如实显示隧道域名（`https://xxxx.trycloudflare.com`）和
 * 本机局域网地址（`http://192.168.x.x:8437`）—— 那是真实网络信息。
 *
 * 用法（这两个函数会被序列化后丢进页面执行，见 page.evaluate）：
 *
 *   const MP = require('./mask-page');
 *   await page.evaluate(MP.mask);     // 截图前
 *   await page.screenshot({ ... });
 *   await page.evaluate(MP.unmask);   // 还要继续跑断言时还原
 *
 * 注意：page.evaluate 靠函数源码序列化，函数体内**不能引用模块外的变量**，
 * 所以正则与占位符都写成字面量写在函数里。要换占位符直接改函数体。
 */
'use strict';

/**
 * 把页面文本/输入框里的真实地址换掉。
 * 原文挂在节点自己的 `__maskOrig` 上，方便 unmask 还原
 * （挂的是 JS 对象属性，不会跟着 innerHTML 跑进 DOM）。
 */
function mask() {
  var LAN_RE = /\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g;
  var HOST_RE = /\b(wss?|https?):\/\/[a-z0-9-]+\.(?:trycloudflare\.com|lhr\.life|localhost\.run)/gi;
  var PLACEHOLDER_IP = '192.168.1.23';
  var PLACEHOLDER_HOST = 'xxxx.trycloudflare.com';
  var scrub = function (s) {
    return String(s)
      .replace(LAN_RE, PLACEHOLDER_IP)
      .replace(HOST_RE, function (m, proto) { return proto + '://' + PLACEHOLDER_HOST; });
  };

  if (!document.__maskOrig) document.__maskOrig = [];
  var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var next = scrub(n.nodeValue);
    if (next === n.nodeValue) continue;
    document.__maskOrig.push(['text', n, n.nodeValue]);
    n.nodeValue = next;
  }
  var inputs = document.querySelectorAll('input, textarea');
  for (var j = 0; j < inputs.length; j++) {
    var el = inputs[j];
    if (!el.value) continue;
    var v = scrub(el.value);
    if (v === el.value) continue;
    document.__maskOrig.push(['value', el, el.value]);
    el.value = v;
  }
  return document.__maskOrig.length;
}

/** 还原 mask() 改过的内容（页面还要继续跑断言时用） */
function unmask() {
  var log = document.__maskOrig || [];
  for (var i = 0; i < log.length; i++) {
    try {
      if (log[i][0] === 'text') log[i][1].nodeValue = log[i][2];
      else log[i][1].value = log[i][2];
    } catch (e) { /* 节点可能已被重建，忽略 */ }
  }
  document.__maskOrig = [];
  return log.length;
}

module.exports = { mask: mask, unmask: unmask };
