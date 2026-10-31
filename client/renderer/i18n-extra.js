/* 茶绘 · 手工补充词条
 *
 * i18n-dict.js 是脚本批量生成的（见 tools/_addwords*.js），重新生成会覆盖里面的内容；
 * 这里放「批量脚本抓不到、但页面上确实会出现」的零散文案：
 *   · 写在 index.html 里的 placeholder（批量脚本只扫 .js）
 *   · 运行时拼出来、又带用户可读单位/符号的组合句
 * 格式与主字典一致：{ '中文原文': ['English', '日本語'] }
 */
(function () {
  'use strict';
  var d = window.ChaI18nDict;
  if (!d) return;
  Object.assign(d, {
    '说点什么…（Enter 发送，Shift+Enter 换行）': [
      'Say something… (Enter to send, Shift+Enter for a new line)',
      '何か入力…（Enter で送信、Shift+Enter で改行）'
    ],
    '在这里输入文字（回车换行）': [
      'Type your text here (Enter for a new line)',
      'ここに文字を入力（Enter で改行）'
    ],
    '摸鱼, 加班, 开会, 咖啡, 团建, 年终奖': [
      'slacking, overtime, meeting, coffee, team building, year-end bonus',
      'サボり, 残業, 会議, コーヒー, 社員旅行, 年末ボーナス'
    ],
    '还没有公开房间': ['No public rooms yet', '公開ルームはまだありません'],
    '右侧创建一个吧': ['Create one on the right', '右側で作成しましょう'],
    // 2.1.9 联机：失败提示 / 通道说明
    '公网入口开好了，但你还没进房间 —— 先进房再点「分享」才有链接': [
      'Public entry is ready, but you are not in a room yet — enter one, then hit Share to get a link',
      '公開エントリは準備できましたが、まだルームに入っていません —— 入室してから「共有」でリンクを取得してください'
    ],
    '房间不存在或已关闭 —— 房主那边已经没有这间房了。让他重新分享一次（他若重启过应用或换过服务器，旧链接就失效了）': [
      'Room not found or closed — the host no longer has this room. Ask them to share again (an old link dies if they restarted the app or changed servers)',
      'ルームが存在しないか閉じられています —— ホスト側にもうこのルームはありません。もう一度共有してもらってください（アプリ再起動やサーバー変更で古いリンクは無効になります）'
    ],
    'P2P 直连（点对点；两边网络打不通时会连不上）': [
      'P2P direct (peer-to-peer; will fail if the two networks cannot reach each other)',
      'P2P 直結（端末同士。ネットワークが繋がらないと接続できません）'
    ],
    'P2P 连接超时 —— 房主可能不在线，或双方网络无法直连（手机流量常见）。让房主换个网络重开，或改用一台公网服务器/中继': [
      'P2P timed out — the host may be offline, or the two networks cannot connect directly (common on mobile data). Ask the host to switch networks, or use a public server/relay',
      'P2P タイムアウト —— ホストが不在か、双方のネットワークが直接繋がりません（モバイル回線でよくあります）。ホストに回線を変えてもらうか、公開サーバー／リレーを使ってください'
    ],
    '连不上 P2P 信令服务器 —— 换一条通道（公网服务器 / 中继）会更稳': [
      'Cannot reach the P2P signalling server — a public server or relay will be more reliable',
      'P2P シグナリングサーバーに繋がりません —— 公開サーバーやリレーを使うと安定します'
    ],
    '网页端': ['Web', 'Web'],
    '浏览器打不开 chahui:// 链接。要让朋友用浏览器进来，需要一台托管网页的机器：任意一台电脑开着茶绘桌面版就行（它内置服务器会同时给出局域网 / 公网页面地址），或者用你自己的公网服务器。装了茶绘的电脑 / 手机点上面的应用链接则可以直接进房。': [
      'A browser cannot open a chahui:// link. To let a friend join from a browser, you need a machine hosting the web page: just leave the desktop app running on any computer (its built-in server gives you both a LAN and a public page address), or use your own public server. Computers and phones with Chahui installed can join directly through the app link above.',
      'ブラウザは chahui:// リンクを開けません。ブラウザから参加してもらうには、Web ページを配信するマシンが必要です：どれか 1 台で茶絵デスクトップ版を起動しておけば（内蔵サーバーが LAN／公開のページアドレスを提示します）、あるいはご自身の公開サーバーを使ってください。茶絵が入っている PC・スマホなら上のアプリリンクから直接入室できます。'
    ],
    '拖动小节标题排序，也能拖到右栏': [
      'Drag a section title to reorder, or to the right panel',
      '見出しをドラッグで並べ替え、右パネルにも移動できます'
    ],

    /* ---------------- 关于对话框的长文（整块替换，见 ChaI18n.html） ----------------
     * 这些文案散落在 <b>/<code>/<a> 之间，逐节点翻语序会乱；按页签名整段查表，
     * 标签结构与 CSS 类名（.warn）保持和中文版一致。
     */
    'about.terms': [
      [
        '<h4>In one sentence</h4>',
        '<p>Chahui is a tool for drawing together with friends. Please don\'t use it to make other people uncomfortable.</p>',
        '<h4>You may</h4>',
        '<ul>',
        '<li>Open your own room, draw whatever you like, and send the link to friends so they can join in.</li>',
        '<li>Draw anything you have the right to draw — commercial use is your own responsibility.</li>',
        '<li>Modify and redistribute Chahui\'s source code (MIT licence, see "Credits & Licence").</li>',
        '</ul>',
        '<h4>Please don\'t</h4>',
        '<ul>',
        '<li><span class="warn">Upload or draw illegal content</span>, including but not limited to anything involving minors, violence or terrorism, or other people\'s privacy.</li>',
        '<li>Bring other people\'s artwork, photos or assets into a room and edit them together without permission.</li>',
        '<li>Use it as an image host or cloud drive, or stuff it with large amounts of data unrelated to drawing.</li>',
        '<li>Stress-test, scan or break into a server, or try to get around a room\'s password.</li>',
        '</ul>',
        '<h4>The room is yours to run</h4>',
        '<p>The host is responsible for the people and content in their room. Public rooms are open to anyone; use a password-protected room for anything important.</p>'
      ].join(''),
      [
        '<h4>ひとことで</h4>',
        '<p>茶絵は友だちと一緒に絵を描くためのツールです。誰かを嫌な気持ちにする使い方はしないでください。</p>',
        '<h4>できること</h4>',
        '<ul>',
        '<li>自分で部屋を開いて、自由に描いて、リンクを友だちに送って一緒に描く。</li>',
        '<li>自分に描く権利のある内容を描く（商用利用の可否は自分で判断してください）。</li>',
        '<li>茶絵のソースコードを改変・再配布する（MIT ライセンス、「謝辞とライセンス」を参照）。</li>',
        '</ul>',
        '<h4>しないでください</h4>',
        '<ul>',
        '<li><span class="warn">違法・規約違反の内容をアップロードしたり描いたりすること</span>。未成年者に関わる内容、暴力・テロ、他者のプライバシー侵害などを含みます。</li>',
        '<li>許諾なく他人の作品・写真・素材を部屋に持ち込んで一緒に改変すること。</li>',
        '<li>画像置き場やオンラインストレージとして使うこと、絵と無関係な大量のデータを置くこと。</li>',
        '<li>サーバーへの負荷テスト・スキャン・侵入、または部屋のパスワードを回避しようとすること。</li>',
        '</ul>',
        '<h4>部屋は自分の責任で</h4>',
        '<p>部屋の主には、その部屋の人と内容を管理する責任があります。公開ルームは誰でも入れます。大事な内容はパスワード付きの部屋を使ってください。</p>'
      ].join('')
    ],

    'about.risk': [
      [
        '<h4>Please read this page first</h4>',
        '<p>Chahui is a small project. <span class="warn">Treat it as a handy way to draw with people you know, not as reliable storage</span>.</p>',
        '<h4>Your drawings can be lost</h4>',
        '<ul>',
        '<li>Room data lives on the server, <span class="warn">with no cloud backup</span>. If the server crashes, a disk dies, or a room is left alone long enough to be reclaimed, the content is gone.</li>',
        '<li>Empty rooms (nobody online and not a single stroke) are cleaned up automatically; rooms with content are reclaimed after sitting idle for too long.</li>',
        '<li><b>Export important drawings as PNG to your own computer whenever you like.</b></li>',
        '</ul>',
        '<h4>Online sessions are not encrypted</h4>',
        '<ul>',
        '<li>Plain text by default — <code>ws://</code> / <code>http://</code>. Other people on the same network, or routers in between, could in theory see what you draw and chat about.</li>',
        '<li>A room password is only a door, <span class="warn">not encryption</span> — don\'t use it to protect anything sensitive.</li>',
        '<li>When you use <code>npm run expose</code> to put the server on the internet, anyone with the link can get in — shut it down when you stop drawing.</li>',
        '</ul>',
        '<h4>Collaboration means "everyone edits everything"</h4>',
        '<ul>',
        '<li>In the same room anyone can edit any layer. There are no permission levels and no "lock someone else\'s layer".</li>',
        '<li>Others can undo their own strokes and clear layers; the host can dissolve the whole room.</li>',
        '<li>For a serious piece, agree on who does what first, or open separate rooms.</li>',
        '</ul>',
        '<h4>Imported brushes and fonts</h4>',
        '<ul>',
        '<li>Imported <code>.abr</code> / <code>.sut</code> brushes remain the copyright of their authors — make sure you\'re allowed to use them. Chahui can\'t and won\'t judge that for you.</li>',
        '<li>Import only reads the tip shape and spacing; the original file is never modified.</li>',
        '</ul>',
        '<h4>Disclaimer</h4>',
        '<p>This project is open source under the MIT licence and <b>provided "as is", without any warranty</b>. The author is not liable for lost artwork, data leaks or any other damages caused by using it.</p>'
      ].join(''),
      [
        '<h4>まずこのページを読んでください</h4>',
        '<p>茶絵は小さなプロジェクトです。<span class="warn">「知っている人と一緒に描くための便利な道具」として扱ってください。信頼できる保存先ではありません</span>。</p>',
        '<h4>描いた絵は消えることがあります</h4>',
        '<ul>',
        '<li>部屋のデータはサーバー上にあり、<span class="warn">クラウドバックアップはありません</span>。サーバーが落ちたり、ディスクが壊れたり、長く放置されて部屋が回収されたりすると内容は失われます。</li>',
        '<li>空の部屋（誰もおらず一筆も描かれていない部屋）は自動で片付けられ、内容のある部屋も長く放置すると回収されます。</li>',
        '<li><b>大事な絵はこまめに「PNG 書き出し」で自分のパソコンに保存してください。</b></li>',
        '</ul>',
        '<h4>通信は暗号化されていません</h4>',
        '<ul>',
        '<li>既定では平文です — <code>ws://</code> / <code>http://</code>。同じネットワークの他の人や途中のルーターは、理論上あなたが何を描き何を話しているか見られます。</li>',
        '<li>部屋のパスワードは入室の入口にすぎず、<span class="warn">暗号化ではありません</span>。機密の保護には使わないでください。</li>',
        '<li><code>npm run expose</code> でサーバーをインターネットに公開すると、リンクを知っている人は誰でも入れます — 描き終わったら止めてください。</li>',
        '</ul>',
        '<h4>共同作業は「全員が全部を編集できる」</h4>',
        '<ul>',
        '<li>同じ部屋では誰でもどのレイヤーでも編集できます。権限の段階も、他人のレイヤーをロックする仕組みもありません。</li>',
        '<li>他の人は自分の描いたものを取り消したり、レイヤーを消したりできます。部屋の主は部屋ごと解散できます。</li>',
        '<li>本格的な作品を一緒に描くときは、分担を先に決めるか、それぞれ別の部屋を開いてください。</li>',
        '</ul>',
        '<h4>読み込んだブラシとフォント</h4>',
        '<ul>',
        '<li>読み込んだ <code>.abr</code> / <code>.sut</code> ブラシの著作権は作者にあります。使う権利があるか確認してください。茶絵が代わりに判断することはできません。</li>',
        '<li>読み込みは筆先の形状と間隔だけを読み取り、元のファイルは変更しません。</li>',
        '</ul>',
        '<h4>免責</h4>',
        '<p>本プロジェクトは MIT ライセンスで公開されており、<b>「現状のまま」提供され、いかなる保証も伴いません</b>。利用によって生じた作品の消失、データ漏洩その他の損害について、作者は責任を負いません。</p>'
      ].join('')
    ],

    'about.credits': [
      [
        '<h4>Licence</h4>',
        '<p>This project is open source under the <b>MIT licence</b>: you may use, modify and redistribute it as long as you keep the copyright notice. The full text is in the <code>LICENSE</code> file in the repository.</p>',
        '<h4>References &amp; thanks</h4>',
        '<ul>',
        '<li>The interface and brush system follow the publicly documented habits of <b>PaintTool SAI Ver.2</b> — it merely "feels similar"; there is no affiliation with SAI.</li>',
        '<li>The <code>.abr</code> binary layout was written with reference to <a href="https://github.com/Agamnentzar/ag-psd">ag-psd</a> and calibrated against a batch of real brush files.</li>',
        '<li>The "embedded PNG tip" approach for <code>.sut</code> (CSP) was inspired by <a href="https://github.com/Leon-Schoenbrunn/CSP2PC">CSP2PC</a>.</li>',
        '<li>Internet tunnelling uses the quick tunnels of <a href="https://github.com/cloudflare/cloudflared">cloudflared</a>.</li>',
        '</ul>',
        '<h4>Third party</h4>',
        '<ul>',
        '<li>Electron (desktop shell) and ws (WebSocket server) — each under its own licence.</li>',
        '</ul>'
      ].join(''),
      [
        '<h4>ライセンス</h4>',
        '<p>本プロジェクトは <b>MIT ライセンス</b> で公開されています：著作権表示を残せば、自由に使用・改変・再配布できます。全文はリポジトリの <code>LICENSE</code> にあります。</p>',
        '<h4>参考と謝辞</h4>',
        '<ul>',
        '<li>UI とブラシ体系は <b>PaintTool SAI Ver.2</b> の公開されている操作感を参考にしています —— 「似た使い心地」を目指しただけで、SAI 公式とは一切関係ありません。</li>',
        '<li><code>.abr</code> のバイナリ構造は <a href="https://github.com/Agamnentzar/ag-psd">ag-psd</a> の実装を参考にし、実際のブラシファイルで調整しました。</li>',
        '<li><code>.sut</code>（CSP）の「PNG 筆先を内蔵する」方式は <a href="https://github.com/Leon-Schoenbrunn/CSP2PC">CSP2PC</a> を参考にしました。</li>',
        '<li>インターネット公開には <a href="https://github.com/cloudflare/cloudflared">cloudflared</a> のクイックトンネルを使っています。</li>',
        '</ul>',
        '<h4>サードパーティ</h4>',
        '<ul>',
        '<li>Electron（デスクトップ版のシェル）、ws（WebSocket サーバー）—— それぞれのライセンスに従います。</li>',
        '</ul>'
      ].join('')
    ],
    // ---- 2.2.0 跨 WiFi 联机（公共中继 relay://）----
    '直连打不通（跨 WiFi / 手机流量常见），已自动切到公共中继 —— 一样能画，延迟略高': [
      'Direct connection failed (common across different Wi-Fi networks or mobile data), switched to the public relay — still works, slightly higher latency',
      '直接接続に失敗しました（別々の Wi-Fi やモバイル回線でよくあります）。公共リレーに切り替えました —— 描けますが、少し遅延します'
    ],
    '两边网络直连打不通，已自动改用公共中继…': [
      'The two networks cannot reach each other directly — switching to the public relay…',
      '両者のネットワークは直接つながりません —— 公共リレーに切り替えます…'
    ],
    '直连打不通，正在改用公共中继…': [
      'Direct connection failed — switching to the public relay…',
      '直接接続に失敗しました —— 公共リレーに切り替えます…'
    ],
    'P2P 信令不通，正在改用公共中继…': [
      'P2P signalling unreachable — switching to the public relay…',
      'P2P シグナリングに接続できません —— 公共リレーに切り替えます…'
    ],
    '连不上公共中继 —— 换个网络试试（公司/校园网常封 WSS）': [
      'Cannot reach the public relay — try another network (company/campus networks often block WSS)',
      '公共リレーに接続できません —— 別のネットワークを試してください（社内・学内ネットワークは WSS を遮断することが多いです）'
    ],
    '公共中继（免服务器，跨 WiFi 也能连；延迟略高）': [
      'Public relay (no server needed, works across different Wi-Fi; slightly higher latency)',
      '公共リレー（サーバー不要、別々の Wi-Fi でも接続可。少し遅延します）'
    ],
    'P2P 直连（点对点；两边网络打不通时自动改走公共中继）': [
      'P2P direct (peer-to-peer; falls back to the public relay if the two networks cannot connect)',
      'P2P 直接接続（端末同士。つながらない場合は公共リレーに自動で切り替わります）'
    ],
    '缺少中继组件（vendor/mqtt.min.js 或 mqtt-relay.js 没加载）': [
      'Relay component missing (vendor/mqtt.min.js or mqtt-relay.js not loaded)',
      'リレー部品がありません（vendor/mqtt.min.js または mqtt-relay.js が読み込まれていません）'
    ],
    '公共中继连接已断开': [
      'Public relay connection lost',
      '公共リレーの接続が切れました'
    ],
    '缺少 MQTT 组件（vendor/mqtt.min.js 没加载）': [
      'MQTT component missing (vendor/mqtt.min.js not loaded)',
      'MQTT 部品がありません（vendor/mqtt.min.js が読み込まれていません）'
    ],
    '还没有房间号，无法开中继': [
      'No room yet — cannot start the relay',
      'まだルームに入っていないため、リレーを開始できません'
    ],
    '公共中继都连不上': [
      'Cannot reach any public relay',
      'どの公共リレーにも接続できません'
    ]
  });
})();
