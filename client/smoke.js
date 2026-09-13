// 桌面端冒烟测试：真实 Electron 环境加载页面，抓取报错并验证引擎可用后自动退出
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const errors = [];
let win;

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.on('console-message', (e, level, message) => {
    // 打包后会消失的 Electron 开发期安全提示，不计入失败
    if (/Electron Security Warning/.test(message)) return;
    if (level >= 2) errors.push('[console] ' + message);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => errors.push('[failload] ' + desc + ' ' + url));

  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const check = () => win.webContents.executeJavaScript(`(function(){
    var out = { engine: typeof window.CanvasEngine, app: typeof window.ChaApp, desktop: !!(window.chahuDesktop && window.chahuDesktop.isDesktop) };
    try {
      var eng = window.ChaApp.engine;
      eng.init({ width: 800, height: 600, background: '#ffffff', layers: [{ id: 'L1', name: '图层 1' }] });
      var id = 'smoke1';
      eng.beginStroke({ id: id, layerId: 'L1', tool: 'brush', color: '#ec4141', size: 10, opacity: 1, local: true });
      var pts = [];
      for (var i = 0; i < 40; i++) pts.push([50 + i * 12, 300 + Math.sin(i / 4) * 60, 0.5]);
      eng.addPoints(id, pts);
      eng.endStroke(id, 1);
      out.strokes = eng.strokes.length;
      var png = eng.exportPNG();
      out.png = png.length;
      out.ink = (function(){
        var d = eng.renderDocument({}).ctx.getImageData(0,0,800,600).data, n = 0;
        for (var i = 0; i < d.length; i += 28) if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) n++;
        return n;
      })();
      eng.setReplayMode(true);
      out.replay = eng.replayStrokes.length;
      eng.setReplayMode(false);
    } catch (e) { out.err = e.message + ' | ' + e.stack; }
    return out;
  })()`);

  let ok = false;
  try {
    await new Promise(r => setTimeout(r, 600));
    const r = await check();
    console.log('SMOKE_RESULT ' + JSON.stringify(r));
    ok = !r.err && r.engine === 'function' && r.app === 'object' && r.desktop === true &&
         r.strokes === 1 && r.ink > 100 && r.replay === 1;
  } catch (e) {
    console.log('SMOKE_EXCEPTION ' + e.message);
  }

  await new Promise(r => setTimeout(r, 300));
  console.log('SMOKE_ERRORS ' + JSON.stringify(errors));
  console.log('SMOKE_VERDICT ' + (ok && errors.length === 0 ? 'PASS' : 'FAIL'));
  app.exit(ok && errors.length === 0 ? 0 : 1);
});
