// 名刺管理君アプリ（PWA）。
// 画面だけを受け持ち、データの出し入れはすべて各社のGAS（AppApi）に任せる。
// 名刺のデータはこの端末にもこのサイトにも保存しない（端末に覚えるのはGASのURLとログイン中のトークンだけ）。
(function () {
  'use strict';

  var CONFIG = window.MEISHI_CONFIG || {};
  var API_URL_STORE = 'meishi.api';
  var TOKEN_KEY = 'meishi.idt';
  var GAS_URL_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/;
  var IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var MAX_RECORD_MS = 30000;

  var state = {
    apiUrl: '',
    idToken: '',
    tab: 'register',
    shots: { front: null, back: null },
    batch: [],         // まとめて登録: [{ front: {base64, dataUrl}, back: {…}|null }, …]
    shootFor: null,    // 'front' | 'back' | 'addBack' | { batch: 番号（-1＝新しい名刺）, side: 'front'|'back' }
    card: null,        // 詳細で開いている名刺
    tokenWaiters: [],
    session: 0,        // ログアウト・ログイン切れのたびに増やす。前の回の応答は画面に出さない
  };

  // =========================
  //  小物
  // =========================
  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else if (k === 'onclick') node.addEventListener('click', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function storageGet(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function storageSet(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* 保存できなくても動かす */ } }
  function sessionGet(key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function sessionSet(key, v) { try { v ? sessionStorage.setItem(key, v) : sessionStorage.removeItem(key); } catch (e) { /* 同上 */ } }

  function msg(id, text, kind) {
    var p = $(id);
    p.textContent = text || '';
    p.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function busy(text) {
    $('busy-text').textContent = text || '処理しています…';
    $('busy').hidden = false;
  }
  function idle() { $('busy').hidden = true; }

  function show(view) {
    ['setup', 'login', 'main', 'detail'].forEach(function (v) { $('view-' + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  /** 写真を長い辺 max px の JPEG に縮小し、base64 で返す（送る量を減らす） */
  function resizeImage(file, max) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.round(img.naturalWidth * scale);
        var h = Math.round(img.naturalHeight * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve({ dataUrl: dataUrl, base64: dataUrl.split(',')[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('写真を読み込めませんでした')); };
      img.src = url;
    });
  }

  // =========================
  //  設定（この会社のGASのURL）
  // =========================
  function validApiUrl(u) {
    if (IS_LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) return true;
    return GAS_URL_RE.test(u);
  }

  /** 接続先の URL の見分けやすい部分（/s/ の後ろの末尾8文字） */
  function apiLabel(u) {
    var m = String(u || '').match(/\/s\/([A-Za-z0-9_-]+)\//);
    return m ? '…' + m[1].slice(-8) : u;
  }

  /**
   * 接続先（この会社の GAS）を決める。リンクの ?api= は、確認して OK のときだけ使う
   * （まだ設定がないときも、すでに別の接続先が設定されているときも）。
   * （知らない人から届いたリンクで接続先を書き換えられ、ログインの情報をその人の GAS に送ってしまうのを防ぐ）
   */
  function loadApiUrl() {
    var params = new URLSearchParams(location.search);
    var fromLink = params.get('api');
    var saved = storageGet(API_URL_STORE);
    if (fromLink && validApiUrl(fromLink) && fromLink !== saved) {
      var question = validApiUrl(saved)
        ? '接続先（会社の名刺管理君）を切り替えますか？\n\n今の接続先: ' + apiLabel(saved) + '\n新しい接続先: ' + apiLabel(fromLink)
        : 'このリンクの接続先（会社の名刺管理君）を使いますか？\n\n接続先: ' + apiLabel(fromLink);
      if (confirm(question + '\n\n会社の導入担当から受け取ったリンクのときだけ「OK」を押してください。心当たりがなければ「キャンセル」を押してください。')) {
        storageSet(API_URL_STORE, fromLink);
        sessionSet(TOKEN_KEY, '');
        saved = fromLink;
      }
    }
    // 読み終えた ?api= はアドレスから消す（再読み込みで何度も確認が出ないように）
    if (fromLink) {
      params.delete('api');
      try { history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); } catch (e) { /* 消せなくても動かす */ }
    }
    state.apiUrl = validApiUrl(saved) ? saved : '';
  }

  $('setup-save').addEventListener('click', function () {
    var u = $('setup-url').value.trim();
    if (!validApiUrl(u)) {
      msg('setup-msg', '設定コードの形が違います。https://script.google.com/macros/s/…/exec の形のURLを貼り付けてください。', 'err');
      return;
    }
    if (u !== storageGet(API_URL_STORE)) sessionSet(TOKEN_KEY, '');
    storageSet(API_URL_STORE, u);
    state.apiUrl = u;
    start();
  });

  // =========================
  //  ログイン（Google）
  // =========================
  function decodeJwt(token) {
    try {
      var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(atob(part).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  /** 接続先の URL の ID（/s/ と /exec の間）。手元の模擬環境は 'local' */
  function apiId(u) {
    var m = String(u || '').match(/\/s\/([A-Za-z0-9_-]+)\//);
    return m ? m[1] : (IS_LOCAL ? 'local' : '');
  }

  /**
   * ログインのトークンに入れる nonce。先頭を今の接続先の ID にする（GAS の Auth.verify が確かめる）。
   * 偽の接続先に送らされたトークンは、本物の名刺管理君では通らない
   */
  function loginNonce() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return apiId(state.apiUrl) + '.' + Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /** 期限まで1分以上あり、今の接続先あてのトークンか */
  function tokenValid(token) {
    var p = token && decodeJwt(token);
    return !!(p && p.exp * 1000 - Date.now() > 60 * 1000 &&
              String(p.nonce || '').split('.')[0] === apiId(state.apiUrl));
  }

  function setToken(token) {
    state.idToken = token || '';
    sessionSet(TOKEN_KEY, state.idToken);
    var p = token && decodeJwt(token);
    $('who').textContent = p ? p.email : '';
    $('logout').hidden = !state.idToken;
  }

  function onCredential(res) {
    // 前の接続先で初期化したときのログインが遅れて届いたら使わない（今の接続先あてのトークンだけ使う）
    if (!(IS_LOCAL && CONFIG.devIdToken) && !tokenValid(res.credential)) {
      msg('login-msg', 'ログインをやり直してください（接続先が変わったため）。', 'err');
      return;
    }
    setToken(res.credential);
    var waiters = state.tokenWaiters.splice(0);
    waiters.forEach(function (w) { w(state.idToken); });
    if (!$('view-login').hidden) { show('main'); }
  }

  function initGoogle() {
    if (IS_LOCAL && CONFIG.devIdToken) return true;   // 手元の模擬環境だけ
    if (!CONFIG.googleClientId) {
      msg('login-msg', 'アプリの設定が終わっていません（GoogleのクライアントIDが未設定）。\n導入担当にお知らせください。', 'err');
      return false;
    }
    if (!(window.google && google.accounts && google.accounts.id)) return false;
    google.accounts.id.initialize({
      client_id: CONFIG.googleClientId,
      nonce: loginNonce(),
      callback: onCredential,
      auto_select: true,
      itp_support: true,
      use_fedcm_for_prompt: true,
    });
    google.accounts.id.renderButton($('gsi-button'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
    return true;
  }

  /** 有効なトークンを返す。切れていれば自動でのログインを試し、だめならログイン画面を出す */
  function freshToken() {
    if (IS_LOCAL && CONFIG.devIdToken) return Promise.resolve(CONFIG.devIdToken);
    if (tokenValid(state.idToken)) return Promise.resolve(state.idToken);
    return new Promise(function (resolve, reject) {
      var done = false;
      state.tokenWaiters.push(function (t) { done = true; resolve(t); });
      try { google.accounts.id.prompt(); } catch (e) { /* 下のタイマーでログイン画面へ */ }
      setTimeout(function () {
        if (done) return;
        state.tokenWaiters.splice(0);
        endSession('ログインの有効期限が切れました。もう一度ログインしてください。', 'err');
        reject(new Error('ログインが必要です'));
      }, 6000);
    });
  }

  /**
   * 「閉じる」＝ログアウト。ホーム画面のアプリは自分では閉じられないため、
   * ログインを解除し、画面に出ている名刺・写真・入力中の文字も消してログイン画面に戻す。
   */
  function logout() {
    if (!state.idToken || !confirm('ログアウトして閉じますか？\n次に開いたときは、ログインからになります。')) return;
    try { google.accounts.id.disableAutoSelect(); } catch (e) { /* 未読み込みでも続ける */ }
    endSession('ログアウトしました。アプリを閉じるときは、スマホの操作で閉じてください。', 'ok');
  }

  /**
   * ログインを終える（ログアウト・ログイン切れの両方）。トークンを消し、画面に出ている名刺・写真・入力中の文字を消し、
   * 録音を止める。session を増やすので、終える前に送った要求の応答は画面に出ない。
   */
  function endSession(text, kind) {
    state.session++;
    setToken('');
    stopRecording();
    try { google.accounts.id.cancel(); } catch (e) { /* ログインの案内が出ていなければ何もしない */ }
    idle();
    resetShots();
    state.batch = [];
    renderBatch();
    state.card = null;
    ['search-input', 'ask-input', 'batch-comment', 'comment-input', 'file-card', 'file-face'].forEach(function (id) { $(id).value = ''; });
    $('ask-answer').textContent = '';
    ['register-result', 'batch-results', 'search-results', 'ask-results', 'detail-body', 'detail-images'].forEach(function (id) { $(id).replaceChildren(); });
    ['register-msg', 'batch-msg', 'search-msg', 'ask-msg', 'detail-msg'].forEach(function (id) { msg(id, ''); });
    $('ask-answer').hidden = true;
    selectTab('register');
    show('login');
    msg('login-msg', text, kind);
  }

  $('who').addEventListener('click', logout);
  $('logout').addEventListener('click', logout);

  // =========================
  //  GAS とのやり取り
  // =========================
  /**
   * @returns {Promise<Object>} GAS の応答（ok:false でも返す。呼び出し元が message を出す）
   */
  function api(action, params) {
    var session = state.session;
    var never = function () { return new Promise(function () {}); };   // 終えたログインの応答は捨てる
    return freshToken().then(function (idToken) {
      if (session !== state.session) return never();
      var body = Object.assign({ action: action, idToken: idToken }, params || {});
      return fetch(state.apiUrl, {
        method: 'POST',
        // text/plain にすると事前確認（プリフライト）が出ず、GAS がそのまま受け取れる
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
      }).catch(function (e) {
        throw new Error('通信できませんでした。電波のよい場所でもう一度お試しください。\n[原因] ' + e.message);
      }).then(function (res) {
        return res.json().catch(function () {
          throw new Error('応答を読めませんでした。\n[原因] HTTP ' + res.status);
        });
      }).then(function (json) {
        if (session !== state.session) return never();
        if (!json.ok && json.code === 'AUTH') {
          endSession(json.message, 'err');
          return never();
        }
        return json;
      }, function (e) {
        if (session !== state.session) return never();   // 通信の失敗も、終えたログインの分は画面に出さない
        throw e;
      });
    }, function (e) {
      if (session !== state.session) return never();   // ログイン切れで終えた。ログイン画面に案内済み
      throw e;
    });
  }

  /** 失敗時の表示文（GAS の message、または通信エラー） */
  function errText(x) { return (x && (x.message || String(x))) || '失敗しました。'; }

  // =========================
  //  名刺の表示
  // =========================
  function safeHref(kind, value) {
    if (kind === 'tel') return 'tel:' + value.replace(/[^0-9+]/g, '');
    if (kind === 'mail') return 'mailto:' + value;
    return /^https?:\/\//i.test(value) ? value : 'https://' + value;
  }

  function renderCard(card) {
    var dl = el('dl');
    function add(label, value, linkKind) {
      if (!value) return;
      var dd = el('dd');
      if (linkKind === 'tel') {
        value.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (v, i) {
          if (i) dd.appendChild(document.createTextNode('\n'));
          dd.appendChild(el('a', { href: safeHref('tel', v), text: v }));
        });
      } else if (linkKind) {
        dd.appendChild(el('a', { href: safeHref(linkKind, value), text: value, target: '_blank', rel: 'noopener noreferrer' }));
      } else {
        dd.textContent = value;
      }
      dl.appendChild(el('dt', { text: label }));
      dl.appendChild(dd);
    }
    add('会社', card.company);
    add('役職', card.title);
    add('仕事内容', card.job);
    add('電話', card.phone, 'tel');
    add('メール', card.email, 'mail');
    add('住所', card.address);
    add('URL', card.url, 'url');
    add('裏面', card.back_text);
    add('備考', card.note);
    add('コメント', card.comment);
    add('登録日', card.date);

    return el('div', { class: 'card' }, [
      el('h3', { text: card.name_ja || '(名前なし)' }),
      card.name_en ? el('p', { class: 'en', text: card.name_en }) : null,
      dl,
    ]);
  }

  function listItem(r, onOpen, reason) {
    var sub = [r.company, r.title].filter(Boolean).join(' / ');
    return el('li', {}, [el('button', { onclick: onOpen }, [
      el('span', { class: 'name', text: r.name_ja || '(名前なし)' }),
      sub ? el('span', { class: 'sub', text: sub }) : null,
      r.latestComment ? el('span', { class: 'sub', text: '💬 ' + r.latestComment }) : null,
      reason ? el('span', { class: 'reason', text: reason }) : null,
    ])]);
  }

  // =========================
  //  タブ
  // =========================
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { selectTab(b.dataset.tab); });
  });

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    });
    ['register', 'search', 'ask'].forEach(function (t) { $('tab-' + t).hidden = t !== tab; });
  }

  // =========================
  //  登録
  // =========================
  function mode() { return document.querySelector('input[name="mode"]:checked').value; }

  function refreshRegister() {
    var batch = mode() === 'batch';
    $('single-area').hidden = batch;
    $('single-actions').hidden = batch;
    $('batch-area').hidden = !batch;
    $('shot-back').hidden = mode() !== 'both';
    $('do-register').disabled = !state.shots.front || (mode() === 'both' && !state.shots.back);
    $('do-batch').disabled = !state.batch.length;
    $('do-batch').textContent = state.batch.length ? 'まとめて登録する（' + state.batch.length + '枚）' : 'まとめて登録する';
  }

  document.querySelectorAll('input[name="mode"]').forEach(function (r) { r.addEventListener('change', refreshRegister); });

  document.querySelectorAll('.shoot[data-side]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.shootFor = b.dataset.side;
      $('file-card').value = '';
      $('file-card').click();
    });
  });

  $('file-card').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var target = state.shootFor;
    var session = state.session;
    resizeImage(file, 1600).then(function (img) {
      if (session !== state.session) return;   // 縮めている間にログアウトした
      if (target === 'addBack') return addBack(img.base64);
      if (typeof target === 'object') return putBatchShot(target, img);
      state.shots[target] = img.base64;
      var prev = $('prev-' + target);
      prev.src = img.dataUrl;
      prev.hidden = false;
      refreshRegister();
    }).catch(function (e) {
      if (session !== state.session) return;
      msg(target === 'addBack' ? 'detail-msg' : typeof target === 'object' ? 'batch-msg' : 'register-msg', errText(e), 'err');
    });
  });

  function resetShots() {
    state.shots = { front: null, back: null };
    ['front', 'back'].forEach(function (s) { $('prev-' + s).hidden = true; $('prev-' + s).removeAttribute('src'); });
    refreshRegister();
  }

  $('do-register').addEventListener('click', function () {
    var images = [{ side: 'front', data: state.shots.front }];
    if (mode() === 'both') images.push({ side: 'back', data: state.shots.back });
    msg('register-msg', '');
    $('register-result').replaceChildren();
    busy('名刺を読み取っています…');
    api('register', { images: images }).then(function (res) {
      idle();
      if (res.ok) {
        resetShots();
        msg('register-msg', ['登録しました。'].concat(res.notes || []).join('\n'), 'ok');
        showRegistered(res.card);
        return;
      }
      msg('register-msg', res.message, 'err');
      if (res.code === 'E002' && res.duplicate) showDuplicate(res);
    }).catch(function (e) { idle(); msg('register-msg', errText(e), 'err'); });
  });

  function showRegistered(card) {
    $('register-result').replaceChildren(
      renderCard(card),
      el('div', { class: 'after-actions' }, [
        el('button', { text: '👤 顔写真を追加', onclick: function () { openDetail(card.row, function () { pickFace(); }); } }),
        el('button', { text: '💬 コメントを追加', onclick: function () { openDetail(card.row, function () { openComment(); }); } }),
      ])
    );
  }

  function showDuplicate(res) {
    var d = res.duplicate;
    var buttons = [el('button', { text: '登録済みの名刺を開く', onclick: function () { openDetail(d.row); } })];
    if (res.pendingId) {
      buttons.unshift(el('button', { text: '📷 登録済みの名刺に今回の裏面を追加', onclick: function () {
        busy('裏面を追加しています…');
        api('applyPendingBack', { pendingId: res.pendingId }).then(function (r) {
          idle();
          if (!r.ok) { msg('register-msg', r.message, 'err'); return; }
          resetShots();
          msg('register-msg', ['裏面を追加しました。'].concat(r.notes || []).join('\n'), 'ok');
          showRegistered(r.card);
        }).catch(function (e) { idle(); msg('register-msg', errText(e), 'err'); });
      } }));
    }
    $('register-result').replaceChildren(el('div', { class: 'after-actions' }, buttons));
  }

  // =========================
  //  まとめて登録
  // =========================
  function shootBatch(index, side) {
    state.shootFor = { batch: index, side: side };
    $('file-card').value = '';
    $('file-card').click();
  }

  $('batch-add').addEventListener('click', function () { shootBatch(-1, 'front'); });

  function putBatchShot(target, img) {
    var shot = { base64: img.base64, dataUrl: img.dataUrl };
    if (target.batch === -1) state.batch.push({ front: shot, back: null });
    else state.batch[target.batch][target.side] = shot;
    renderBatch();
  }

  function renderBatch() {
    var list = $('batch-list');
    list.replaceChildren.apply(list, state.batch.map(function (c, i) {
      // 写真を押すと撮り直し。裏がまだ無い名刺は、表の右に「📷 裏を撮る」を出す
      function slot(side, label) {
        var shot = c[side];
        return el('button', { class: shot ? '' : 'take', 'aria-label': (i + 1) + '枚目の' + label, onclick: function () { shootBatch(i, side); } },
          [shot ? el('img', { src: shot.dataUrl, alt: label }) : el('span', { text: '📷 裏を撮る' })]);
      }
      return el('li', {}, [
        el('div', { class: 'no', text: (i + 1) + '枚目（左が表・右が裏。写真を押すと撮り直し）' }),
        el('div', { class: 'pair' }, [
          slot('front', '表'),
          slot('back', '裏'),
          el('button', { class: 'del', text: '外す', 'aria-label': (i + 1) + '枚目を外す', onclick: function () {
            state.batch.splice(i, 1);
            renderBatch();
          } }),
        ]),
      ]);
    }));
    // 一覧のすぐ下に「次の名刺の表を撮る」を出す
    var n = state.batch.length;
    $('batch-add').textContent = n ? '📷 次の名刺（' + (n + 1) + '枚目）の表を撮る' : '📷 1枚目の表を撮る';
    $('batch-list').hidden = !n;
    refreshRegister();
  }

  /**
   * 1枚ずつ順に register を呼ぶ（GAS の1回の処理時間の上限を超えないため）。
   * 登録できた名刺と登録済みだった名刺は一覧から外し、失敗したものだけ残して撮り直さずにやり直せるようにする。
   */
  $('do-batch').addEventListener('click', function () {
    var items = state.batch.slice();
    var comment = $('batch-comment').value.trim();
    var results = $('batch-results');
    var done = { ok: 0, dup: 0, err: 0 };
    var failed = [];
    results.replaceChildren();
    msg('batch-msg', '');

    function finish(stoppedAt) {
      idle();
      state.batch = failed.concat(stoppedAt == null ? [] : items.slice(stoppedAt));
      renderBatch();
      var text = '登録 ' + done.ok + '枚 ／ 登録済み ' + done.dup + '枚 ／ 失敗 ' + done.err + '枚';
      if (stoppedAt != null) text += '\nログインが切れたため、' + (stoppedAt + 1) + '枚目で止めました。ログインし直して、もう一度「まとめて登録する」を押してください。';
      else if (failed.length) text += '\n失敗した名刺は上の一覧に残しています。もう一度「まとめて登録する」を押すと、その分だけやり直します。';
      msg('batch-msg', text, done.err || stoppedAt != null ? 'err' : 'ok');
      if (!state.batch.length && stoppedAt == null) $('batch-comment').value = '';
    }

    (function next(i) {
      if (i >= items.length) { finish(null); return; }
      busy('名刺を読み取っています…（' + (i + 1) + ' / ' + items.length + '枚）');
      var c = items[i];
      var images = [{ side: 'front', data: c.front.base64 }];
      if (c.back) images.push({ side: 'back', data: c.back.base64 });
      api('register', { images: images, comment: comment }).then(function (res) {
        if (!res.ok && res.code === 'AUTH') { finish(i); return; }
        results.appendChild(batchResult(i + 1, res));
        if (res.ok) done.ok++;
        else if (res.code === 'E002') done.dup++;
        else { done.err++; failed.push(c); }
        next(i + 1);
      }).catch(function (e) {
        if (!tokenValid(state.idToken) && !(IS_LOCAL && CONFIG.devIdToken)) { finish(i); return; }
        results.appendChild(batchResult(i + 1, { ok: false, message: errText(e) }));
        done.err++;
        failed.push(c);
        next(i + 1);
      });
    })(0);
  });

  function batchResult(no, res) {
    var head, body = [], actions = [];
    if (res.ok) {
      head = el('span', { class: 'status-ok', text: no + '枚目：登録しました' });
      body.push(el('span', { class: 'name', text: res.card.name_ja || '(名前なし)' }));
      body.push(el('span', { class: 'sub', text: [res.card.company, res.card.title].filter(Boolean).join(' / ') }));
      (res.notes || []).forEach(function (n) { body.push(el('span', { class: 'sub', text: n })); });
      actions.push(el('button', { text: '開く', onclick: function () { openDetail(res.row); } }));
    } else if (res.code === 'E002' && res.duplicate) {
      var d = res.duplicate;
      head = el('span', { class: 'status-warn', text: no + '枚目：登録済みの名刺でした' });
      body.push(el('span', { class: 'name', text: d.name_ja || '(名前なし)' }));
      body.push(el('span', { class: 'sub', text: d.company || '' }));
      actions.push(el('button', { text: '登録済みを開く', onclick: function () { openDetail(d.row); } }));
      if (res.pendingId) {
        var btn = el('button', { text: '今回の裏面を追加', onclick: function () {
          busy('裏面を追加しています…');
          api('applyPendingBack', { pendingId: res.pendingId }).then(function (r) {
            idle();
            btn.disabled = true;
            btn.textContent = r.ok ? '裏面を追加しました' : '追加できませんでした';
            if (!r.ok) msg('batch-msg', r.message, 'err');
            else if ((r.notes || []).length) msg('batch-msg', no + '枚目：' + r.notes.join('\n'), 'err');
          }).catch(function (e) { idle(); msg('batch-msg', errText(e), 'err'); });
        } });
        actions.push(btn);
      }
    } else {
      head = el('span', { class: 'status-err', text: no + '枚目：登録できませんでした' });
      body.push(el('span', { class: 'sub', text: res.message || '' }));
    }
    return el('li', {}, [el('div', { class: 'result' }, [head].concat(body).concat(
      actions.length ? [el('div', { class: 'inline-actions' }, actions)] : []
    ).map(function (n) { var w = el('div'); w.appendChild(n); return w; }))]);
  }

  // =========================
  //  探す
  // =========================
  // 探す項目（チェックボックス）。チェックした項目を合わせて探す
  var SEARCH_FIELDS = {
    name:    { hint: '名前（姓だけでも可。姓と名の間の空白はあってもなくてもよい）', placeholder: '例：田中' },
    company: { hint: '会社名（「ニッサン」でも「日産」が見つかる）', placeholder: '例：ニッサン' },
    free:    { hint: '名前・会社名・仕事内容・裏面・コメントのどこか', placeholder: '例：補助金' },
  };

  function searchFields() {
    return Array.prototype.map.call(document.querySelectorAll('input[name="field"]:checked'), function (c) { return c.value; });
  }

  function refreshSearch() {
    var fields = searchFields();
    $('search-hint').textContent = fields.length
      ? fields.map(function (f) { return '・' + SEARCH_FIELDS[f].hint; }).join('\n')
      : '探す項目を1つ以上チェックしてください。';
    $('search-input').placeholder = fields.length ? SEARCH_FIELDS[fields[0]].placeholder : '';
    $('do-search').disabled = !fields.length;
  }

  document.querySelectorAll('input[name="field"]').forEach(function (r) {
    r.addEventListener('change', function () {
      refreshSearch();
      // 選び直したら、入っている言葉でそのまま探し直す。全部外したら前の結果を消す
      if (!searchFields().length) { $('search-results').replaceChildren(); msg('search-msg', ''); }
      else if ($('search-input').value.trim()) $('do-search').click();
    });
  });

  $('do-search').addEventListener('click', function () {
    var keyword = $('search-input').value.trim();
    var fields = searchFields();
    $('search-results').replaceChildren();
    if (!fields.length) { msg('search-msg', '探す項目を1つ以上チェックしてください。', 'err'); return; }
    if (!keyword) { msg('search-msg', 'キーワードを入れてください。', 'err'); return; }
    msg('search-msg', '');
    busy('探しています…');
    api('search', { keyword: keyword, fields: fields }).then(function (res) {
      idle();
      if (!res.ok) { msg('search-msg', res.message, 'err'); return; }
      var notes = res.notes || [];
      if (!res.total) { msg('search-msg', ['「' + keyword + '」に合う名刺は見つかりませんでした。'].concat(notes).join('\n')); return; }
      msg('search-msg', [res.total + '件' + (res.total > res.results.length ? '（上位' + res.results.length + '件を表示）' : '')].concat(notes).join('\n'));
      $('search-results').replaceChildren.apply($('search-results'), res.results.map(function (r) {
        return listItem(r, function () { openDetail(r.row); });
      }));
    }).catch(function (e) { idle(); msg('search-msg', errText(e), 'err'); });
  });
  $('search-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('do-search').click(); });

  // =========================
  //  AIに相談
  // =========================
  $('do-ask').addEventListener('click', function () {
    var question = $('ask-input').value.trim();
    if (!question) { msg('ask-msg', '相談したいことを書いてください。', 'err'); return; }
    msg('ask-msg', '');
    $('ask-answer').hidden = true;
    $('ask-results').replaceChildren();
    busy('名刺の中から選んでいます…');
    api('ask', { question: question }).then(function (res) {
      idle();
      if (!res.ok) { msg('ask-msg', res.message, 'err'); return; }
      msg('ask-msg', (res.notes || []).join('\n'));
      $('ask-answer').textContent = res.answer || '';
      $('ask-answer').hidden = !res.answer;
      $('ask-results').replaceChildren.apply($('ask-results'), res.candidates.map(function (c) {
        return listItem(c, function () { openDetail(c.row); }, c.reason);
      }));
    }).catch(function (e) { idle(); msg('ask-msg', errText(e), 'err'); });
  });

  // =========================
  //  声で入力
  // =========================
  var recorder = null;

  /** 録音中なら、文字起こしに送らずに止める（ログアウトのとき） */
  function stopRecording() {
    if (!recorder) return;
    var r = recorder;
    recorder = null;
    r.ondataavailable = null;
    r.onstop = null;
    clearTimeout(r.meishiTimer);
    try { r.stop(); } catch (e) { /* 止まっていても続ける */ }
    try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 同上 */ }
    document.querySelectorAll('.mic').forEach(function (b) { b.classList.remove('rec'); });
  }

  function pickAudioType() {
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    for (var i = 0; i < types.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  /** ブラウザの録音形式を、GAS（Gemini）が受け付ける形式名にそろえる */
  function geminiAudioType(type) {
    var base = String(type || '').split(';')[0];
    return base === 'audio/mp4' ? 'audio/m4a' : base;
  }

  function msgIdFor(targetId) {
    return { 'search-input': 'search-msg', 'ask-input': 'ask-msg', 'batch-comment': 'batch-msg' }[targetId] || 'detail-msg';
  }

  document.querySelectorAll('.mic').forEach(function (b) {
    b.addEventListener('click', function () {
      if (recorder) { recorder.stop(); return; }
      var target = $(b.dataset.target);
      var msgId = msgIdFor(b.dataset.target);
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        msg(msgId, 'この端末のブラウザは録音に対応していません。キーボードのマイクで入力してください。', 'err');
        return;
      }
      var session = state.session;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        if (session !== state.session || recorder) {   // 許可を待つ間にログアウトした・もう録音中
          stream.getTracks().forEach(function (t) { t.stop(); });
          return;
        }
        var type = pickAudioType();
        var chunks = [];
        var mine = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        recorder = mine;
        // 30秒で止める。止めるのは自分の録音だけ（ログアウト後に始めた別の録音は止めない）
        mine.meishiTimer = setTimeout(function () { if (recorder === mine) mine.stop(); }, MAX_RECORD_MS);
        mine.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        mine.onstop = function () {
          clearTimeout(mine.meishiTimer);
          stream.getTracks().forEach(function (t) { t.stop(); });
          var mime = mine.mimeType || type;
          if (recorder === mine) recorder = null;
          b.classList.remove('rec');
          if (session !== state.session) return;   // 録音を始めたあとにログアウトした
          var blob = new Blob(chunks, { type: mime });
          if (!blob.size) { msg(msgId, '録音できませんでした。もう一度お試しください。', 'err'); return; }
          busy('声を文字にしています…');
          var never = function () { return new Promise(function () {}); };
          blobToBase64(blob).then(function (b64) {
            // 音声を読み終える前にログアウト・別の人がログインしていたら送らない（前の人の声を、次の人のログインで送らない）
            if (session !== state.session) return never();
            return api('transcribe', { audio: b64, mimeType: geminiAudioType(mime) });
          }).then(function (res) {
            if (session !== state.session) return;
            idle();
            if (!res.ok) { msg(msgId, res.message, 'err'); return; }
            if (!res.text) { msg(msgId, '聞き取れませんでした。もう一度話してください。', 'err'); return; }
            target.value = res.text;
            msg(msgId, '');
            if (!b.dataset.noauto) $(b.dataset.target === 'search-input' ? 'do-search' : 'do-ask').click();
          }).catch(function (e) {
            if (session !== state.session) return;
            idle(); msg(msgId, errText(e), 'err');
          });
        };
        mine.start();
        b.classList.add('rec');
        msg(msgId, '話してください。終わったらもう一度🎤を押します（30秒で止まります）。');
      }).catch(function (e) {
        msg(msgId, 'マイクを使う許可が必要です。端末の設定でマイクを許可してください。\n[原因] ' + e.message, 'err');
      });
    });
  });

  // =========================
  //  名刺の詳細
  // =========================
  function target() {
    var c = state.card;
    return { row: c.row, name_ja: c.name_ja, company: c.company };
  }

  /**
   * @param {number} row
   * @param {Function} [then] 開いたあとに続けて行う操作（顔写真・コメント）
   */
  function openDetail(row, then) {
    msg('detail-msg', '');
    busy('名刺を開いています…');
    api('detail', { row: row }).then(function (res) {
      idle();
      if (!res.ok) { msg(state.tab + '-msg', res.message, 'err'); return; }
      renderDetail(res.card);
      show('detail');
      if (then) then();
    }).catch(function (e) { idle(); msg(state.tab + '-msg', errText(e), 'err'); });
  }

  function renderDetail(card) {
    state.card = card;
    $('detail-body').replaceChildren(renderCard(card));
    $('act-back').textContent = card.hasBack ? '📷 裏面を撮り直す' : '📷 裏面を追加';
    $('act-face').textContent = card.hasFace ? '👤 顔写真を撮り直す' : '👤 顔写真を追加';
    $('act-comment').textContent = card.comment ? '💬 コメントを書き足す' : '💬 コメントを追加';
    $('comment-box').hidden = true;
    $('comment-input').value = '';
    loadImages(card);
  }

  function loadImages(card) {
    var box = $('detail-images');
    box.replaceChildren();
    [['front', card.hasFront, '名刺（表）'], ['back', card.hasBack, '名刺（裏）'], ['face', card.hasFace, '顔写真']]
      .forEach(function (k) {
        if (!k[1]) return;
        var fig = el('figure', {}, [el('p', { class: 'loading', text: k[2] + 'を読み込み中…' })]);
        box.appendChild(fig);
        api('image', Object.assign({ kind: k[0] }, target())).then(function (res) {
          if (state.card !== card) return;
          if (!res.ok) { fig.replaceChildren(el('p', { class: 'msg err', text: res.message })); return; }
          fig.replaceChildren(
            el('img', { src: 'data:' + res.mimeType + ';base64,' + res.data, alt: k[2] }),
            el('figcaption', { text: k[2] })
          );
        }).catch(function (e) { fig.replaceChildren(el('p', { class: 'msg err', text: errText(e) })); });
      });
  }

  $('detail-back').addEventListener('click', function () { show('main'); });

  $('act-back').addEventListener('click', function () {
    state.shootFor = 'addBack';
    $('file-card').value = '';
    $('file-card').click();
  });

  function addBack(base64) {
    busy('裏面を読み取っています…');
    api('addBack', Object.assign({ image: base64 }, target())).then(function (res) {
      idle();
      if (!res.ok) { msg('detail-msg', res.message, 'err'); return; }
      renderDetail(res.card);
      var lines = ['裏面を追加しました。'];
      if (res.filled && res.filled.length) lines.push('補った項目: ' + res.filled.join('・'));
      if (res.replaced) lines.push('前の裏面は置き換えました。');
      msg('detail-msg', lines.concat(res.notes || []).join('\n'), 'ok');
    }).catch(function (e) { idle(); msg('detail-msg', errText(e), 'err'); });
  }

  function pickFace() {
    $('file-face').value = '';
    $('file-face').click();
  }
  $('act-face').addEventListener('click', pickFace);

  $('file-face').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var session = state.session;
    var never = function () { return new Promise(function () {}); };
    resizeImage(file, 800).then(function (img) {
      if (session !== state.session || !state.card) return never();   // 縮めている間にログアウトした
      busy('顔写真を保存しています…');
      return api('addPhoto', Object.assign({ image: img.base64 }, target()));
    }).then(function (res) {
      idle();
      if (!res.ok) { msg('detail-msg', res.message, 'err'); return; }
      renderDetail(res.card);
      msg('detail-msg', [res.replaced ? '顔写真を撮り直しました。' : '顔写真を追加しました。'].concat(res.notes || []).join('\n'), 'ok');
    }).catch(function (e) { idle(); msg('detail-msg', errText(e), 'err'); });
  });

  function openComment() {
    $('comment-box').hidden = false;
    $('comment-input').focus();
  }
  $('act-comment').addEventListener('click', openComment);

  $('comment-save').addEventListener('click', function () {
    var text = $('comment-input').value.trim();
    if (!text) { msg('detail-msg', 'コメントを書いてください。', 'err'); return; }
    busy('コメントを保存しています…');
    api('addComment', Object.assign({ text: text }, target())).then(function (res) {
      idle();
      if (!res.ok) { msg('detail-msg', res.message, 'err'); return; }
      renderDetail(res.card);
      msg('detail-msg', ['コメントを保存しました。'].concat(res.notes || []).join('\n'), 'ok');
    }).catch(function (e) { idle(); msg('detail-msg', errText(e), 'err'); });
  });

  // =========================
  //  起動
  // =========================
  function start() {
    loadApiUrl();
    if (!state.apiUrl) { show('setup'); return; }

    setToken(sessionGet(TOKEN_KEY));
    if (IS_LOCAL && CONFIG.devIdToken) { setToken(CONFIG.devIdToken); show('main'); return; }
    if (tokenValid(state.idToken)) { show('main'); }
    else { show('login'); }

    // Google のログイン部品は非同期で読み込まれるので、そろうまで待つ
    var tries = 0;
    (function waitGoogle() {
      if (initGoogle()) {
        if (!tokenValid(state.idToken)) { try { google.accounts.id.prompt(); } catch (e) { /* ボタンで入れる */ } }
        return;
      }
      if (!CONFIG.googleClientId) return;
      if (++tries > 50) { msg('login-msg', 'Google のログイン部品を読み込めませんでした。電波を確かめて、アプリを開き直してください。', 'err'); return; }
      setTimeout(waitGoogle, 200);
    })();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.log('service worker 登録失敗', e); });
    });
  }

  refreshRegister();
  refreshSearch();
  start();
})();
