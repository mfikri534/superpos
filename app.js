/* POS SuperApp frontend — vanilla ES modules are intentionally avoided for static hosting. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const STORAGE = {
    api: 'pos_api_url', token: 'pos_session_token', user: 'pos_user', settings: 'pos_settings', shift: 'pos_shift',
    catalog: 'pos_catalog_cache', cart: 'pos_cart', held: 'pos_held_local', outbox: 'pos_outbox',
    geminiKey: 'pos_gemini_key', geminiModel: 'pos_gemini_model', printerWidth: 'pos_printer_width'
  };
  const state = {
    apiUrl: localStorage.getItem(STORAGE.api) || (window.POS_CONFIG && window.POS_CONFIG.API_URL) || '',
    token: localStorage.getItem(STORAGE.token) || '',
    user: readJson(STORAGE.user, null), settings: readJson(STORAGE.settings, {}), shift: readJson(STORAGE.shift, null),
    catalog: readJson(STORAGE.catalog, { categories: [], products: [] }),
    page: 'pos', modal: null, cartOpen: false, search: '', category: 'all', cart: readJson(STORAGE.cart, []),
    selectedCustomer: null, customers: [], report: null, dashboard: null, expenses: [], users: [],
    lastReceipt: null, moreOpen: false, online: navigator.onLine,
    reportFrom: isoDate(new Date()), reportTo: isoDate(new Date()), reportPreset: 'today',
    reportFilters: { customer_id: '', cashier_id: '', payment_method: '', category_id: '' },
    aiMessages: [], aiBusy: false, cameraStream: null, cameraFrame: null, scanTarget: null, scanReturnModal: null,
    syncBusy: false, productEdit: null, debts: readJson('pos_debts', [])
  };

  function readJson(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } }
  function saveJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  function money(value) {
    const n = Number(value) || 0;
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: state.settings.currency || 'IDR', maximumFractionDigits: 0 }).format(n);
  }
  function isoDate(date) { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function roleName(role) { return ({ owner:'Owner', admin:'Administrator', manager:'Manager', cashier:'Kasir' })[role] || role || '-'; }
  function canManage() { return ['owner','admin'].includes(state.user?.role); }
  function canManageProducts() { return ['owner','admin','manager'].includes(state.user?.role); }
  function canSeeReports() { return ['owner','admin','manager'].includes(state.user?.role); }
  function showToast(message, type = 'success') {
    const root = $('#toast-root'); if (!root) return;
    const el = document.createElement('div');
    el.className = `toast pointer-events-auto rounded-xl border-2 border-ink px-4 py-3 shadow-hard text-sm font-bold ${type === 'error' ? 'bg-coral' : type === 'warning' ? 'bg-lemon' : 'bg-mint'}`;
    el.textContent = message; root.appendChild(el); setTimeout(() => el.remove(), 3400);
  }
  function fmtDate(v, withTime = false) {
    if (!v) return '-'; const d = new Date(v); if (isNaN(d)) return String(v);
    return new Intl.DateTimeFormat('id-ID', withTime ? { dateStyle:'medium', timeStyle:'short' } : { dateStyle:'medium' }).format(d);
  }
  function icon(name, size = 18) { return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`; }
  function refreshIcons() { if (window.lucide?.createIcons) window.lucide.createIcons(); }
  function persistCart() { saveJson(STORAGE.cart, state.cart); }
  function productById(id) { return state.catalog.products.find(p => String(p.product_id) === String(id)); }
  function cartQty() { return state.cart.reduce((sum, x) => sum + Number(x.qty || 0), 0); }
  function cartTotal() { return state.cart.reduce((sum, x) => sum + Number(x.price || 0) * Number(x.qty || 0) - Number(x.discount || 0), 0); }
  function apiReady() { return /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(state.apiUrl) || /^https?:\/\//.test(state.apiUrl); }

  async function sha256Hex(value) {
    if (!window.crypto?.subtle) throw new Error('Browser tidak mendukung Web Crypto. Gunakan HTTPS atau browser modern.');
    const data = new TextEncoder().encode(String(value));
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
  }
  async function api(action, data = {}, opts = {}) {
    if (!state.apiUrl) throw new Error('URL Google Apps Script belum diisi.');
    const body = { action, data, token: opts.noAuth ? undefined : state.token };
    let response;
    try {
      response = await fetch(state.apiUrl, {
        method: 'POST', mode: 'cors', redirect: 'follow', cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error('Tidak dapat terhubung ke server. Periksa internet dan URL deployment GAS.');
    }
    const raw = await response.text();
    let payload; try { payload = JSON.parse(raw); } catch (_) { throw new Error('Respons GAS bukan JSON. Pastikan Web App sudah di-deploy dengan akses yang benar.'); }
    if (!payload.ok) throw new Error(payload.error || 'Permintaan gagal.');
    return payload.data;
  }

  async function login(username, password, mode = 'password') {
    if (!state.apiUrl) throw new Error('Masukkan URL Google Apps Script terlebih dahulu.');
    const key = await sha256Hex(password);
    const result = await api(mode === 'pin' ? 'auth.pinLogin' : 'auth.login', mode === 'pin' ? { username, pinHash:key } : { username, passwordHash:key }, { noAuth:true });
    state.token = result.token; state.user = result.user;
    localStorage.setItem(STORAGE.token, state.token); saveJson(STORAGE.user, state.user);
    await loadBootstrap();
    showToast(`Selamat datang, ${state.user.full_name.split(' ')[0]}!`);
    render();
    syncOutbox();
  }
  async function loadBootstrap() {
    const data = await api('bootstrap');
    state.user = data.user; state.settings = data.settings || {}; state.catalog = data.catalog || {categories:[],products:[]}; state.shift = data.shift || null;
    state.dashboard = data.dashboard || null;saveJson(STORAGE.shift,state.shift);
    if (['owner','admin','manager'].includes(state.user.role) && state.page === 'pos') state.page = 'dashboard';
    saveJson(STORAGE.user, state.user); saveJson(STORAGE.settings, state.settings); saveJson(STORAGE.catalog, state.catalog);
    if (!canSeeReports()) state.page = 'pos';
  }
  async function refreshCatalog() {
    const data = await api('catalog.list'); state.catalog = data; saveJson(STORAGE.catalog, data);
  }
  async function refreshShift() { state.shift = await api('shifts.current');saveJson(STORAGE.shift,state.shift);return state.shift; }
  async function logout() {
    try { await api('auth.logout'); } catch (_) {}
    state.token = ''; state.user = null; localStorage.removeItem(STORAGE.token); localStorage.removeItem(STORAGE.user); state.cart = []; persistCart(); state.page = 'pos'; render();
  }

  function render() {
    const root = $('#app');
    if (!state.user) { root.innerHTML = renderLogin(); bindLogin(); refreshIcons(); return; }
    root.innerHTML = renderShell(); bindShell(); refreshIcons();
  }

  function renderLogin() {
    const apiUrl = esc(state.apiUrl);
    return `<main class="min-h-[100dvh] grid lg:grid-cols-2 bg-cream">
      <section class="hidden lg:flex p-12 flex-col justify-between bg-mint border-r-2 border-ink">
        <div class="flex items-center gap-3"><div class="h-11 w-11 rounded-2xl bg-white border-2 border-ink shadow-hard grid place-items-center text-xl">▦</div><div><div class="font-extrabold text-xl">POS SuperApp</div><div class="text-xs font-semibold text-slate-600">Retail & F&B workspace</div></div></div>
        <div class="max-w-lg"><span class="pill bg-white border border-ink">SELL SMARTER</span><h1 class="text-5xl font-extrabold tracking-tight leading-[1.08] mt-5">Kasir cepat.<br>Bisnis lebih <span class="underline decoration-4">terukur.</span></h1><p class="text-slate-700 mt-5 text-lg leading-relaxed">Kelola transaksi, stok, pelanggan, shift, dan performa toko dalam satu ruang kerja.</p><div class="grid grid-cols-2 gap-3 mt-9"><div class="bento p-4"><div class="text-2xl">⚡</div><div class="font-extrabold mt-2">Checkout cepat</div><div class="text-xs text-slate-600 mt-1">Scanner & pembayaran split</div></div><div class="bento p-4"><div class="text-2xl">📈</div><div class="font-extrabold mt-2">Laporan detail</div><div class="text-xs text-slate-600 mt-1">Omzet, margin, pelanggan</div></div></div></div>
        <div class="text-xs text-slate-600 font-semibold">POS SuperApp · Powered by Google Sheets + GAS</div>
      </section>
      <section class="flex items-center justify-center p-5 sm:p-8">
        <div class="w-full max-w-md">
          <div class="lg:hidden flex items-center gap-3 mb-10"><div class="h-11 w-11 rounded-2xl bg-mint border-2 border-ink shadow-hard grid place-items-center text-xl">▦</div><div><div class="font-extrabold text-xl">POS SuperApp</div><div class="text-xs text-slate-500">Retail & F&B workspace</div></div></div>
          <div class="mb-7"><span class="pill bg-lavender">SECURE ACCESS</span><h2 class="text-3xl font-extrabold mt-3">Selamat datang 👋</h2><p class="text-sm text-slate-500 mt-2">Masuk untuk mulai mengelola toko.</p></div>
          <form id="login-form" class="space-y-4">
            <div><label class="label" for="api-url">Google Apps Script Web App URL</label><input id="api-url" class="field text-xs" type="url" placeholder="https://script.google.com/macros/s/.../exec" value="${apiUrl}" required></div>
            <div><label class="label" for="login-username">Username</label><input id="login-username" class="field" autocomplete="username" placeholder="username" required></div>
            <div><div class="flex justify-between"><label class="label" for="login-secret" id="secret-label">Password</label><button type="button" id="toggle-login-mode" class="text-xs font-extrabold underline">Gunakan PIN</button></div><input id="login-secret" class="field" type="password" autocomplete="current-password" placeholder="Password akun" required></div>
            <button class="btn btn-primary w-full py-3" type="submit"><span id="login-button-text">Masuk ke aplikasi</span>${icon('arrow-right',17)}</button>
            <p id="login-error" class="text-sm text-rose-600 font-semibold min-h-5"></p>
          </form>
          <div class="mt-8 rounded-xl bg-white border border-slate-200 p-3 text-xs text-slate-500 leading-relaxed"><b class="text-ink">Catatan:</b> API URL disimpan pada browser ini. Pastikan URL berasal dari deployment Web App GAS milik Anda.</div>
        </div>
      </section>
    </main>`;
  }
  function bindLogin() {
    let mode = 'password';
    $('#api-url')?.addEventListener('change', e => { state.apiUrl = e.target.value.trim(); localStorage.setItem(STORAGE.api,state.apiUrl); });
    $('#toggle-login-mode')?.addEventListener('click', () => {
      mode = mode === 'password' ? 'pin' : 'password';
      $('#secret-label').textContent = mode === 'pin' ? 'PIN (4–6 digit)' : 'Password';
      $('#login-secret').type = mode === 'pin' ? 'password' : 'password';
      $('#login-secret').inputMode = mode === 'pin' ? 'numeric' : 'text';
      $('#login-secret').placeholder = mode === 'pin' ? 'Masukkan PIN kasir' : 'Password akun';
      $('#login-button-text').textContent = mode === 'pin' ? 'Masuk dengan PIN' : 'Masuk ke aplikasi';
      $('#toggle-login-mode').textContent = mode === 'pin' ? 'Gunakan password' : 'Gunakan PIN';
    });
    $('#login-form')?.addEventListener('submit', async e => {
      e.preventDefault(); const button = $('button[type="submit"]',e.currentTarget); const error = $('#login-error');
      state.apiUrl = $('#api-url').value.trim(); localStorage.setItem(STORAGE.api,state.apiUrl);
      button.disabled = true; button.innerHTML = 'Memeriksa…'; error.textContent = '';
      try { await login($('#login-username').value, $('#login-secret').value, mode); }
      catch (err) { error.textContent = err.message; button.disabled = false; button.innerHTML = 'Masuk ke aplikasi →'; }
    });
  }

  const NAV = [
    { id:'dashboard', label:'Dashboard', icon:'layout-dashboard', group:'utama', roles:['owner','admin','manager'] },
    { id:'pos', label:'Kasir / POS', icon:'shopping-bag', group:'utama', roles:['owner','admin','manager','cashier'] },
    { id:'products', label:'Produk', icon:'package', group:'kelola', roles:['owner','admin'] },
    { id:'customers', label:'Pelanggan', icon:'users', group:'kelola', roles:['owner','admin','manager','cashier'] },
    { id:'debts', label:'Piutang', icon:'wallet-cards', group:'kelola', roles:['owner','admin','manager','cashier'] },
    { id:'inventory', label:'Inventori', icon:'boxes', group:'kelola', roles:['owner','admin','manager'] },
    { id:'reports', label:'Laporan', icon:'chart-no-axes-combined', group:'analitik', roles:['owner','admin','manager'] },
    { id:'expenses', label:'Pengeluaran', icon:'wallet', group:'analitik', roles:['owner','admin','manager'] },
    { id:'shifts', label:'Shift & Kas', icon:'clock-3', group:'operasional', roles:['owner','admin','manager','cashier'] },
    { id:'history', label:'Riwayat', icon:'receipt-text', group:'operasional', roles:['owner','admin','manager','cashier'] },
    { id:'ai', label:'AI Copilot', icon:'sparkles', group:'lainnya', roles:['owner','admin','manager'] },
    { id:'users', label:'Pengguna', icon:'user-round-cog', group:'lainnya', roles:['owner','admin'] },
    { id:'settings', label:'Pengaturan', icon:'settings-2', group:'lainnya', roles:['owner','admin'] }
  ];
  function allowedNav() { return NAV.filter(x => x.roles.includes(state.user.role)); }
  function renderShell() {
    const nav = allowedNav();
    const pageTitle = nav.find(n => n.id === state.page)?.label || 'POS SuperApp';
    return `<div class="min-h-[100dvh] md:flex">
      <aside class="hidden md:flex w-[232px] shrink-0 border-r border-slate-200 bg-white min-h-screen flex-col px-3 py-5 sticky top-0 h-screen">
        <div class="flex items-center gap-3 px-2 mb-8"><div class="h-10 w-10 rounded-xl bg-mint border-2 border-ink shadow-hard grid place-items-center text-lg">▦</div><div class="min-w-0"><div class="font-extrabold leading-tight truncate">${esc(state.settings.store_name || 'POS SuperApp')}</div><div class="text-[10px] text-slate-500 font-bold tracking-widest">POS SUPERAPP</div></div></div>
        <div class="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest px-3 mb-2">Workspace</div>
        <nav class="space-y-1 flex-1">${nav.map(n => `<button data-page="${n.id}" class="nav-item ${state.page===n.id?'active':''}">${icon(n.icon,17)}<span>${n.label}</span>${n.id==='pos'&&state.cart.length?`<span class="ml-auto pill bg-white">${cartQty()}</span>`:''}</button>`).join('')}</nav>
        <div class="border-t border-slate-200 pt-3 mt-3"><div class="flex items-center gap-2 px-2"><div class="h-9 w-9 rounded-xl bg-lavender grid place-items-center font-extrabold">${esc((state.user.full_name||'U').slice(0,1).toUpperCase())}</div><div class="min-w-0 flex-1"><div class="text-xs font-extrabold truncate">${esc(state.user.full_name)}</div><div class="text-[10px] text-slate-500">${roleName(state.user.role)}</div></div><button class="btn btn-ghost p-2" data-action="logout" title="Keluar">${icon('log-out',16)}</button></div></div>
      </aside>
      <div class="flex-1 min-w-0">
        <header class="sticky top-0 z-30 h-[58px] bg-cream/95 backdrop-blur border-b border-slate-200 px-4 md:px-7 flex items-center justify-between gap-3">
          <div class="min-w-0"><div class="font-extrabold text-base truncate">${esc(pageTitle)}</div><div class="text-[10px] text-slate-500 md:hidden truncate">${esc(state.settings.store_name || 'POS SuperApp')}</div></div>
          <div class="flex items-center gap-2"><span class="pill ${state.online?'bg-mint':'bg-coral'} flex items-center gap-1">● ${state.online?'Online':'Offline'}</span><span class="hidden sm:inline pill ${state.shift?'bg-lemon':'bg-white border border-slate-200'}">${state.shift?'Shift aktif':'Shift belum dibuka'}</span><button class="btn p-2" data-action="open-shift" title="Shift">${icon('clock-3',16)}</button><button class="btn btn-dark p-2" data-page="ai" title="AI Copilot" ${!canSeeReports()?'disabled':''}>${icon('sparkles',16)}</button><button class="md:hidden btn p-2" data-action="more">${icon('menu',17)}</button></div>
        </header>
        <main class="p-3 sm:p-5 md:p-7 safe-bottom max-w-[1600px] mx-auto">${renderPage()}</main>
      </div>
      <nav class="md:hidden bottom-dock fixed z-40 bottom-0 inset-x-0 bg-white/95 backdrop-blur border-t border-slate-200 grid grid-cols-4 px-2 pt-2">
        ${[{id:'pos',label:'Kasir',icon:'shopping-bag'},{id:'products',label:'Produk',icon:'package'},{id:'reports',label:'Laporan',icon:'chart-no-axes-combined'},{id:'more',label:'Lainnya',icon:'grid-2x2'}].map(n=>`<button data-page="${n.id}" data-action="${n.id==='more'?'more':''}" class="flex flex-col items-center gap-1 py-1 text-[10px] font-extrabold ${state.page===n.id?'text-ink':'text-slate-400'}" ${n.id==='products'&&!canManage()?'disabled':''} ${n.id==='reports'&&!canSeeReports()?'disabled':''}>${icon(n.icon,19)}${n.label}</button>`).join('')}
      </nav>
      ${state.modal ? renderModal() : ''}
    </div>`;
  }
  function renderPage() {
    switch (state.page) {
      case 'dashboard': return renderDashboard(); case 'pos': return renderPos(); case 'products': return renderProducts();
      case 'customers': return renderCustomers(); case 'debts': return renderDebts(); case 'inventory': return renderInventory(); case 'reports': return renderReports();
      case 'expenses': return renderExpenses(); case 'shifts': return renderShifts(); case 'history': return renderHistory();
      case 'ai': return renderAi(); case 'users': return renderUsers(); case 'settings': return renderSettings();
      default: return renderPos();
    }
  }

  function renderDashboard() {
    const d = state.dashboard || {};
    const stats = [
      ['Omzet Hari Ini',money(d.revenue),'trending-up','bg-mint'],
      ['Laba Bersih',money(d.net_profit),'wallet','bg-lavender'],
      ['Transaksi',Number(d.transactions||0).toLocaleString('id-ID'),'receipt','bg-lemon'],
      ['Rata-rata Belanja',money(d.aov),'shopping-basket','bg-sky']
    ];
    return `<div class="flex flex-wrap items-end justify-between gap-3 mb-5"><div><p class="text-xs text-slate-500 font-semibold">${fmtDate(new Date())}</p><h1 class="text-2xl font-extrabold mt-1">Ringkasan toko 👋</h1><p class="text-sm text-slate-500 mt-1">Pantau performa operasional hari ini.</p></div><button class="btn btn-primary" data-action="refresh-dashboard">${icon('refresh-cw',16)} Perbarui data</button></div>
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">${stats.map(s=>`<div class="kpi"><div class="flex justify-between items-center"><span class="text-xs text-slate-500 font-bold">${s[0]}</span><span class="h-8 w-8 rounded-lg ${s[3]} grid place-items-center">${icon(s[2],16)}</span></div><div class="mono font-extrabold text-xl sm:text-2xl mt-4 break-words">${s[1]}</div><div class="text-[10px] text-slate-400 mt-1">Periode hari ini</div></div>`).join('')}</div>
      <div class="grid lg:grid-cols-[1.4fr_1fr] gap-4 mt-5">
        <section class="bento p-4"><div class="flex items-center justify-between mb-4"><div><h2 class="font-extrabold">Produk terlaris</h2><p class="text-xs text-slate-500">Berdasarkan jumlah item terjual hari ini</p></div>${icon('chart-column',20)}</div>
          ${(d.top_products||[]).length ? d.top_products.map((p,i)=>`<div class="flex items-center gap-3 py-3 border-b last:border-0 border-slate-100"><span class="h-8 w-8 rounded-lg ${['bg-lemon','bg-lavender','bg-mint','bg-sky','bg-coral'][i%5]} grid place-items-center font-extrabold text-xs">${i+1}</span><div class="flex-1 min-w-0"><div class="font-bold text-sm truncate">${esc(p.name)}</div><div class="h-1.5 rounded-full bg-slate-100 mt-2 overflow-hidden"><div class="h-full bg-ink rounded-full" style="width:${Math.max(8,p.qty/Math.max(1,d.top_products[0].qty)*100)}%"></div></div></div><div class="mono text-sm font-bold">${p.qty} pcs</div></div>`).join('') : `<div class="py-10 text-center text-sm text-slate-400">Belum ada transaksi hari ini.</div>`}
        </section>
        <section class="bento p-4"><div class="flex justify-between items-center mb-4"><div><h2 class="font-extrabold">Stok menipis</h2><p class="text-xs text-slate-500">Perlu segera diperiksa</p></div><span class="pill bg-coral">${(d.low_stock||[]).length} item</span></div>
          ${(d.low_stock||[]).length ? d.low_stock.map(p=>`<div class="flex items-center justify-between gap-2 py-3 border-b border-slate-100 last:border-0"><div class="min-w-0"><div class="font-bold text-sm truncate">${esc(p.name)}</div><div class="text-[11px] text-slate-400">Batas minimum ${p.min_stock} ${esc(p.unit||'pcs')}</div></div><span class="pill bg-coral mono">${p.stock} ${esc(p.unit||'')}</span></div>`).join('') : `<div class="py-10 text-center text-sm text-slate-400">Semua stok aman. Nice!</div>`}
          <button class="btn w-full mt-3" data-page="inventory">Buka inventori ${icon('arrow-up-right',15)}</button>
        </section>
      </div>
      <div class="grid sm:grid-cols-3 gap-3 mt-4"><button class="bento p-4 text-left hover:bg-mint" data-page="pos"><div class="text-xl">🛒</div><div class="font-extrabold mt-2">Mulai transaksi</div><div class="text-xs text-slate-500 mt-1">Buka layar kasir</div></button><button class="bento p-4 text-left hover:bg-lavender" data-page="reports"><div class="text-xl">📊</div><div class="font-extrabold mt-2">Analisis penjualan</div><div class="text-xs text-slate-500 mt-1">Lihat laporan detail</div></button><button class="bento p-4 text-left hover:bg-lemon" data-page="ai"><div class="text-xl">✨</div><div class="font-extrabold mt-2">Tanya AI Copilot</div><div class="text-xs text-slate-500 mt-1">Cari insight bisnis</div></button></div>`;
  }

  function renderPos() {
    const categories = state.catalog.categories || [];
    let products = (state.catalog.products || []).filter(p => String(p.name||'').toLowerCase().includes(state.search.toLowerCase()) || String(p.barcode||'').includes(state.search) || String(p.sku||'').toLowerCase().includes(state.search.toLowerCase()));
    if (state.category !== 'all') products = products.filter(p => String(p.category_id) === String(state.category));
    return `<div class="flex flex-wrap items-end justify-between gap-3 mb-4"><div><h1 class="text-2xl font-extrabold">Kasir cepat</h1><p class="text-sm text-slate-500 mt-1">Pilih produk, cek keranjang, lalu selesaikan pembayaran.</p></div><div class="flex gap-2"><button class="btn" data-action="camera-scan">${icon('scan-line',16)}<span class="hidden sm:inline">Scan</span></button><button class="btn" data-action="refresh-catalog">${icon('refresh-cw',16)}</button></div></div>
      <div class="grid lg:grid-cols-[minmax(0,1.7fr)_minmax(320px,.9fr)] gap-4 items-start">
        <section class="min-w-0">
          <div class="bento p-3 mb-3"><div class="relative"><span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${icon('search',17)}</span><input id="product-search" class="field pl-10 pr-12" placeholder="Cari produk / scan barcode / SKU…" value="${esc(state.search)}"><button class="absolute right-2 top-1/2 -translate-y-1/2 btn btn-ghost p-2" data-action="clear-search">${icon('x',15)}</button></div>
            <div class="flex gap-2 overflow-x-auto scrollbar-none mt-3 pb-1"><button class="pill border ${state.category==='all'?'bg-ink text-white border-ink':'bg-white border-slate-200'}" data-category="all">Semua</button>${categories.map(c=>`<button class="pill border ${state.category===String(c.category_id)?'bg-ink text-white border-ink':'bg-white border-slate-200'}" data-category="${esc(c.category_id)}">${esc(c.icon||'▦')} ${esc(c.name)}</button>`).join('')}</div>
          </div>
          <div id="product-list" class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">${products.map((p,i)=>`<button class="product-card" data-add-product="${esc(p.product_id)}" ${Number(p.stock)<=0&&String(state.settings.allow_negative_stock)!=='true'?'disabled':''}><div class="flex items-start justify-between gap-2"><div class="product-tile ${['bg-mint','bg-lavender','bg-lemon','bg-sky','bg-coral'][i%5]}">${esc((categories.find(c=>c.category_id===p.category_id)?.icon)||'▦')}</div><span class="pill ${Number(p.stock)<=Number(p.min_stock)?'bg-coral':'bg-slate-100'}">${Number(p.stock)} ${esc(p.unit||'pcs')}</span></div><div class="font-extrabold text-sm mt-3 line-clamp-2 min-h-10">${esc(p.name)}</div><div class="text-[10px] text-slate-400 mt-1">${esc(p.sku||p.barcode||'')}</div><div class="mono font-extrabold mt-2">${money(p.sell_price)}</div></button>`).join('') || `<div class="col-span-full bento-soft p-8 text-center text-sm text-slate-400">Produk tidak ditemukan. Tambahkan produk dari menu Produk.</div>`}</div>
        </section>
        <aside class="hidden lg:block sticky top-[74px]">${renderCartPanel()}</aside>
      </div>
      <div class="lg:hidden fixed bottom-[68px] inset-x-3 z-30"><button class="btn btn-dark w-full py-3 shadow-hard" data-action="open-cart"><span class="pill bg-lemon text-ink">${cartQty()} item</span><span class="flex-1 text-left">Lihat keranjang</span><span class="mono">${money(cartTotal())}</span>${icon('arrow-up',17)}</button></div>
      ${state.cartOpen ? `<div class="modal-backdrop" data-action="close-cart"><div class="modal-sheet" data-stop-click><div class="flex justify-between items-center mb-3"><div><h3 class="font-extrabold text-lg">Keranjang belanja</h3><p class="text-xs text-slate-500">${cartQty()} item</p></div><button class="btn p-2" data-action="close-cart">${icon('x',17)}</button></div>${renderCartPanel(true)}</div></div>` : ''}`;
  }

  function renderCartPanel(inSheet = false) {
    const items = state.cart.map(item => ({...item, product:productById(item.product_id)}));
    const subtotal = cartTotal(); const totals = calcCartTotals();
    return `<div class="bento p-4 ${inSheet?'shadow-none':''}"><div class="flex justify-between items-center"><div><h2 class="font-extrabold text-lg">Keranjang</h2><p class="text-xs text-slate-500">${cartQty()} item dipilih</p></div><div class="flex gap-1"><button class="btn btn-ghost p-2" data-action="hold-cart" title="Tahan pesanan">${icon('pause-circle',17)}</button><button class="btn btn-ghost p-2" data-action="clear-cart" title="Kosongkan">${icon('trash-2',17)}</button></div></div>
      ${items.length ? `<div class="space-y-3 my-4 max-h-[34vh] overflow-y-auto pr-1">${items.map(it=>`<div class="flex gap-2 items-center"><div class="h-9 w-9 rounded-lg bg-lavender grid place-items-center text-sm">▦</div><div class="flex-1 min-w-0"><div class="font-bold text-sm truncate">${esc(it.product?.name||'Produk tidak tersedia')}</div><div class="mono text-[11px] text-slate-500">${money(it.price)} × ${it.qty}</div></div><div class="text-right"><div class="mono text-sm font-bold">${money(it.price*it.qty-it.discount)}</div><div class="flex items-center justify-end gap-1 mt-1"><button class="h-6 w-6 rounded-md bg-slate-100 font-bold" data-qty="${esc(it.product_id)}" data-delta="-1">−</button><span class="w-5 text-center text-xs font-extrabold">${it.qty}</span><button class="h-6 w-6 rounded-md bg-mint font-bold" data-qty="${esc(it.product_id)}" data-delta="1">+</button></div></div></div>`).join('')}</div>` : `<div class="py-10 text-center text-sm text-slate-400"><div class="text-3xl mb-2">🛍️</div>Keranjang masih kosong</div>`}
      <div class="border-t border-dashed border-slate-300 pt-3 space-y-2"><div class="flex justify-between text-sm"><span class="text-slate-500">Subtotal</span><b class="mono">${money(totals.subtotal)}</b></div><div class="flex justify-between items-center text-sm"><span class="text-slate-500">Diskon transaksi</span><div class="flex items-center gap-1"><span class="mono text-xs">Rp</span><input id="cart-discount" type="number" min="0" max="${subtotal}" class="field w-28 py-1.5 text-right mono text-xs" value="${Number(window._posDiscount||0)}"></div></div><div class="flex justify-between text-xs"><span class="text-slate-500">Pajak</span><b class="mono">${money(totals.tax)}</b></div><div class="flex justify-between text-lg font-extrabold"><span>Total</span><span class="mono cart-total">${money(totals.grand)}</span></div></div>
      <div class="mt-3"><label class="label">Pelanggan (opsional)</label><div class="flex gap-2"><select id="cart-customer" class="field text-sm"><option value="">Pelanggan umum</option>${state.customers.map(c=>`<option value="${esc(c.customer_id)}" ${state.selectedCustomer?.customer_id===c.customer_id?'selected':''}>${esc(c.name)}${c.phone?' · '+esc(c.phone):''}</option>`).join('')}</select><button class="btn p-2" data-action="quick-customer">${icon('user-plus',16)}</button></div></div>
      <div class="grid grid-cols-2 gap-2 mt-3"><button class="btn" data-action="show-held">${icon('archive',15)} Pesanan</button><button class="btn btn-primary" data-action="checkout" ${!items.length?'disabled':''}>Bayar ${icon('arrow-right',16)}</button></div>
    </div>`;
  }

  function renderProducts() {
    const products = state.catalog.products || [];
    return `<div class="flex flex-wrap justify-between items-end gap-3 mb-4"><div><h1 class="text-2xl font-extrabold">Produk & katalog</h1><p class="text-sm text-slate-500 mt-1">Kelola harga, barcode, kategori, dan stok awal.</p></div><div class="flex gap-2"><button class="btn" data-action="add-category">${icon('folder-plus',16)} Kategori</button><button class="btn btn-primary" data-action="add-product">${icon('plus',16)} Tambah produk</button></div></div>
      <div class="bento overflow-hidden"><div class="p-3 border-b border-slate-100 flex gap-2"><input id="products-filter" class="field" placeholder="Cari nama, SKU, barcode…"><span class="pill bg-lavender self-center">${products.length} produk</span></div><div id="products-rows">${products.length ? products.map(p=>productRow(p)).join('') : `<div class="p-10 text-center text-sm text-slate-400">Belum ada produk. Tambahkan produk pertama Anda.</div>`}</div></div>`;
  }
  function productRow(p) {
    const cat = state.catalog.categories.find(c=>c.category_id===p.category_id)?.name || 'Tanpa kategori';
    return `<div class="table-row product-row" data-search="${esc([p.name,p.sku,p.barcode,cat].join(' ').toLowerCase())}"><div class="min-w-0"><div class="font-extrabold text-sm truncate">${esc(p.name)}</div><div class="mobile-sub text-[10px] text-slate-400 mt-1">${esc(p.sku||p.barcode||'Tanpa SKU')} · ${esc(cat)}</div><div class="desk-col text-xs text-slate-400 mt-1">${esc(p.barcode||'Tanpa barcode')} · ${esc(cat)}</div></div><div class="desk-col text-right"><div class="mono text-sm font-bold">${money(p.sell_price)}</div><div class="text-[10px] text-slate-400">Modal ${money(p.buy_price)}</div></div><div class="row-amount flex justify-end items-center gap-2"><div class="text-right"><div class="mono text-sm font-bold">${Number(p.stock)} ${esc(p.unit||'pcs')}</div><div class="text-[10px] text-slate-400">Stok</div></div><button class="btn p-2" data-edit-product="${esc(p.product_id)}">${icon('pencil',15)}</button></div></div>`;
  }
  function renderCustomers() {
    return `<div class="flex flex-wrap justify-between items-end gap-3 mb-4"><div><h1 class="text-2xl font-extrabold">Pelanggan</h1><p class="text-sm text-slate-500 mt-1">Database pelanggan, loyalitas, dan riwayat belanja.</p></div><button class="btn btn-primary" data-action="add-customer">${icon('user-plus',16)} Tambah pelanggan</button></div>
      <div class="bento overflow-hidden"><div class="p-3 border-b border-slate-100"><input id="customer-search" class="field" placeholder="Cari nama, nomor telepon, email…"></div><div id="customer-rows">${state.customers.length?state.customers.map(customerRow).join(''):`<div class="p-10 text-center text-sm text-slate-400">Belum ada data pelanggan.</div>`}</div></div>`;
  }
  function renderDebts() {
    const open=(state.debts||[]).filter(d=>d.status==='open');
    return `<div class="mb-4"><h1 class="text-2xl font-extrabold">Piutang pelanggan</h1><p class="text-sm text-slate-500 mt-1">Pantau saldo Kasbon dan catat pembayaran angsuran.</p></div>
      <div class="grid grid-cols-2 gap-3 mb-4"><div class="kpi"><div class="text-xs text-slate-500 font-bold">Piutang aktif</div><div class="mono text-2xl font-extrabold mt-2">${open.length}</div></div><div class="kpi"><div class="text-xs text-slate-500 font-bold">Total belum tertagih</div><div class="mono text-xl sm:text-2xl font-extrabold mt-2">${money(open.reduce((s,d)=>s+Number(d.outstanding_amount||0),0))}</div></div></div>
      <div class="bento overflow-hidden"><div class="p-3 border-b border-slate-100 flex items-center justify-between"><span class="font-extrabold text-sm">Daftar Kasbon</span><button class="btn p-2" data-action="refresh-debts">${icon('refresh-cw',15)}</button></div>${open.length?open.map(d=>`<div class="table-row"><div class="min-w-0"><div class="font-extrabold text-sm truncate">${esc(d.customer_name||'Pelanggan')}</div><div class="mobile-sub text-[10px] text-slate-400">${esc(d.invoice_no||'')} · ${fmtDate(d.created_at)}</div><div class="desk-col text-xs text-slate-400">${esc(d.invoice_no||'')} · Awal ${money(d.original_amount)}</div></div><div class="desk-col text-right text-xs text-slate-500">Awal ${money(d.original_amount)}</div><div class="row-amount flex items-center justify-end gap-2"><div class="mono font-extrabold text-sm">${money(d.outstanding_amount)}</div><button class="btn btn-primary p-2" data-pay-debt="${esc(d.debt_id)}">${icon('wallet',15)}</button></div></div>`).join(''):`<div class="p-10 text-center text-sm text-slate-400">Tidak ada piutang terbuka. Semua beres!</div>`}</div>`;
  }
  function customerRow(c) {
    return `<div class="table-row customer-row" data-search="${esc([c.name,c.phone,c.email].join(' ').toLowerCase())}"><div class="min-w-0 flex items-center gap-3"><div class="h-9 w-9 rounded-xl bg-lavender grid place-items-center font-extrabold">${esc((c.name||'?').slice(0,1).toUpperCase())}</div><div class="min-w-0"><div class="font-extrabold text-sm truncate">${esc(c.name)}</div><div class="mobile-sub text-[10px] text-slate-400 mt-1">${esc(c.phone||c.email||'Tanpa kontak')}</div><div class="desk-col text-xs text-slate-400">${esc(c.phone||'')} ${c.email?'· '+esc(c.email):''}</div></div></div><div class="desk-col text-right"><div class="font-bold text-sm">${Number(c.visit_count||0)}x</div><div class="text-[10px] text-slate-400">Kunjungan</div></div><div class="row-amount text-right"><div class="mono font-bold text-sm">${money(c.total_spent)}</div><div class="text-[10px] text-slate-400">Belanja</div></div></div>`;
  }
  function renderInventory() {
    const products = state.catalog.products || [];
    return `<div class="mb-4"><h1 class="text-2xl font-extrabold">Inventori & stok</h1><p class="text-sm text-slate-500 mt-1">Pantau stok kritis dan catat hasil stock opname.</p></div>
      <div class="grid grid-cols-2 gap-3 mb-4"><div class="kpi"><div class="text-xs text-slate-500 font-bold">Total SKU aktif</div><div class="mono font-extrabold text-2xl mt-2">${products.length}</div></div><div class="kpi"><div class="text-xs text-slate-500 font-bold">Stok kritis</div><div class="mono font-extrabold text-2xl mt-2">${products.filter(p=>Number(p.stock)<=Number(p.min_stock)).length}</div></div></div>
      <div class="bento overflow-hidden"><div class="p-3 border-b border-slate-100"><input id="inventory-filter" class="field" placeholder="Cari produk untuk penyesuaian stok…"></div><div id="inventory-rows">${products.map(p=>`<div class="table-row inventory-row" data-search="${esc([p.name,p.sku,p.barcode].join(' ').toLowerCase())}"><div class="min-w-0"><div class="font-extrabold text-sm truncate">${esc(p.name)}</div><div class="mobile-sub text-[10px] text-slate-400">SKU ${esc(p.sku||'-')} · Min. ${p.min_stock}</div><div class="desk-col text-xs text-slate-400">SKU ${esc(p.sku||'-')} · Minimum ${p.min_stock} ${esc(p.unit||'pcs')}</div></div><div class="desk-col text-right"><span class="pill ${Number(p.stock)<=Number(p.min_stock)?'bg-coral':'bg-mint'}">${Number(p.stock)<=Number(p.min_stock)?'Kritis':'Aman'}</span></div><div class="row-amount flex justify-end items-center gap-2"><div class="mono font-extrabold text-sm">${p.stock} ${esc(p.unit||'')}</div><button class="btn p-2" data-adjust-stock="${esc(p.product_id)}">${icon('sliders-horizontal',15)}</button></div></div>`).join('') || `<div class="p-8 text-center text-sm text-slate-400">Belum ada produk.</div>`}</div></div>`;
  }
  function renderReports() {
    const r = state.report; const s = r?.summary || {};
    const presets = [['today','Hari ini'],['yesterday','Kemarin'],['7d','7 hari'],['month','Bulan ini'],['custom','Custom']];
    return `<div class="flex flex-wrap justify-between items-end gap-3 mb-4"><div><h1 class="text-2xl font-extrabold">Laporan penjualan</h1><p class="text-sm text-slate-500 mt-1">Omzet, laba, produk terlaris, dan performa pelanggan.</p></div><button class="btn" data-action="export-report">${icon('download',16)} Export CSV</button></div>
      <section class="bento p-3 mb-4"><div class="flex flex-wrap gap-2 mb-3">${presets.map(p=>`<button class="pill border ${state.reportPreset===p[0]?'bg-ink text-white border-ink':'bg-white border-slate-200'}" data-preset="${p[0]}">${p[1]}</button>`).join('')}</div><div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2"><div><label class="label">Dari tanggal</label><input id="report-from" type="date" class="field text-sm" value="${state.reportFrom}"></div><div><label class="label">Sampai tanggal</label><input id="report-to" type="date" class="field text-sm" value="${state.reportTo}"></div><div><label class="label">Pelanggan</label><select id="report-customer" class="field text-sm"><option value="">Semua pelanggan</option>${(r?.customers||state.customers).map(c=>`<option value="${esc(c.customer_id)}" ${state.reportFilters.customer_id===c.customer_id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div><label class="label">Metode bayar</label><select id="report-payment" class="field text-sm"><option value="">Semua metode</option>${['Tunai','QRIS','Transfer','Kartu','Kasbon'].map(m=>`<option ${state.reportFilters.payment_method===m?'selected':''}>${m}</option>`).join('')}</select></div><div><label class="label">Kasir</label><select id="report-cashier" class="field text-sm"><option value="">Semua kasir</option>${(r?.cashiers||[]).map(c=>`<option value="${esc(c.user_id)}" ${state.reportFilters.cashier_id===c.user_id?'selected':''}>${esc(c.full_name)}</option>`).join('')}</select></div><div><label class="label">Kategori</label><select id="report-category" class="field text-sm"><option value="">Semua kategori</option>${(r?.categories_master||state.catalog.categories||[]).map(c=>`<option value="${esc(c.category_id)}" ${state.reportFilters.category_id===c.category_id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div></div><div class="flex justify-end mt-3"><button class="btn btn-primary" data-action="run-report">${icon('filter',15)} Terapkan filter</button></div></section>
      ${r ? `<div class="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">${[['Omzet',money(s.revenue),'bg-mint'],['Laba bersih',money(s.net_profit),'bg-lavender'],['Transaksi',s.transaction_count||0,'bg-lemon'],['Rata-rata transaksi',money(s.aov),'bg-sky']].map(x=>`<div class="kpi"><div class="text-xs font-bold text-slate-500">${x[0]}</div><div class="mono text-lg sm:text-xl font-extrabold mt-3 break-words">${x[1]}</div><div class="h-1.5 rounded-full mt-3 ${x[2]}"></div></div>`).join('')}</div>
      <div class="grid lg:grid-cols-2 gap-4 mb-4"><div class="bento p-4"><h3 class="font-extrabold">Komposisi laba</h3><div class="space-y-3 mt-4">${[['Omzet',s.revenue],['HPP',-s.cogs],['Pengeluaran',-s.expenses],['Laba bersih',s.net_profit]].map((x,i)=>`<div><div class="flex justify-between text-xs mb-1"><span class="text-slate-500">${x[0]}</span><b class="mono">${money(x[1])}</b></div><div class="h-2 bg-slate-100 rounded-full overflow-hidden"><div class="h-full rounded-full ${i===3?'bg-mint':i===0?'bg-sky':'bg-coral'}" style="width:${Math.min(100,Math.abs(x[1]||0)/Math.max(1,s.revenue)*100)}%"></div></div></div>`).join('')}</div></div><div class="bento p-4"><h3 class="font-extrabold">Kategori penjualan</h3>${(r.categories||[]).length?(r.categories||[]).map((c,i)=>`<div class="flex items-center justify-between py-3 border-b border-slate-100 last:border-0"><div class="flex gap-2 items-center"><span class="h-3 w-3 rounded-sm ${['bg-mint','bg-lavender','bg-lemon','bg-sky','bg-coral'][i%5]}"></span><span class="text-sm font-bold">${esc(c.name)}</span></div><span class="mono text-xs font-bold">${money(c.value)}</span></div>`).join(''):`<p class="text-sm text-slate-400 py-8 text-center">Belum ada data.</p>`}</div></div>
      <div class="grid lg:grid-cols-2 gap-4"><div class="bento p-4"><h3 class="font-extrabold mb-3">Produk terlaris</h3>${(r.top_products||[]).map((p,i)=>`<div class="flex justify-between py-2 border-b border-slate-100 last:border-0 text-sm"><span>${i+1}. ${esc(p.name)}</span><b class="mono">${p.qty}</b></div>`).join('')||'<p class="text-sm text-slate-400">Belum ada penjualan pada rentang ini.</p>'}</div><div class="bento p-4"><h3 class="font-extrabold mb-3">Transaksi</h3><div class="max-h-72 overflow-y-auto">${(r.transactions||[]).slice(0,30).map(t=>`<div class="flex justify-between gap-3 py-2 border-b border-slate-100 text-xs"><div class="min-w-0"><b>${esc(t.invoice_no)}</b><div class="text-slate-400">${fmtDate(t.timestamp,true)} · ${esc(t.customer_name)}</div></div><b class="mono whitespace-nowrap">${money(t.grand_total)}</b></div>`).join('')||'<p class="text-sm text-slate-400 py-6 text-center">Tidak ada transaksi.</p>'}</div></div></div>` : `<div class="bento p-10 text-center text-sm text-slate-400">Pilih rentang waktu, lalu tekan Terapkan filter.</div>`}`;
  }
  function renderExpenses() {
    const total = state.expenses.reduce((s,e)=>s+Number(e.amount||0),0);
    return `<div class="flex flex-wrap justify-between items-end gap-3 mb-4"><div><h1 class="text-2xl font-extrabold">Pengeluaran</h1><p class="text-sm text-slate-500 mt-1">Catat biaya operasional untuk menghitung laba bersih.</p></div><button class="btn btn-primary" data-action="add-expense">${icon('plus',16)} Catat biaya</button></div><div class="kpi mb-4"><div class="text-xs text-slate-500 font-bold">Total pengeluaran pada data termuat</div><div class="mono text-2xl font-extrabold mt-2">${money(total)}</div></div><div class="bento overflow-hidden">${state.expenses.length?state.expenses.map(e=>`<div class="table-row"><div><div class="font-extrabold text-sm">${esc(e.description||e.category)}</div><div class="mobile-sub text-[10px] text-slate-400">${fmtDate(e.date_str)} · ${esc(e.payment_method)}</div><div class="desk-col text-xs text-slate-400">${esc(e.category)} · ${fmtDate(e.date_str)}</div></div><div class="desk-col text-right text-xs text-slate-500">${esc(e.payment_method)}</div><div class="row-amount mono font-extrabold text-sm">${money(e.amount)}</div></div>`).join(''):`<div class="p-10 text-center text-sm text-slate-400">Belum ada pengeluaran.</div>`}</div>`;
  }
  function renderShifts() {
    const s = state.shift;
    return `<div class="mb-4"><h1 class="text-2xl font-extrabold">Shift & kas</h1><p class="text-sm text-slate-500 mt-1">Kelola modal awal, arus kas, dan rekonsiliasi kasir.</p></div>
      <div class="grid lg:grid-cols-2 gap-4"><section class="bento p-5"><div class="flex items-center justify-between"><div><span class="pill ${s?'bg-mint':'bg-lemon'}">${s?'SHIFT AKTIF':'SHIFT TERTUTUP'}</span><h2 class="text-xl font-extrabold mt-3">${s?'Shift sedang berjalan':'Mulai operasional'}</h2></div><div class="h-12 w-12 bg-lavender rounded-xl grid place-items-center">${icon('clock-3',23)}</div></div>
        ${s?`<div class="mt-5 space-y-3"><div class="flex justify-between text-sm"><span class="text-slate-500">Waktu buka</span><b>${fmtDate(s.opened_at,true)}</b></div><div class="flex justify-between text-sm"><span class="text-slate-500">Modal awal</span><b class="mono">${money(s.opening_cash)}</b></div><button class="btn btn-dark w-full mt-3" data-action="close-shift">Tutup shift & hitung kas ${icon('arrow-right',16)}</button><button class="btn w-full" data-action="cash-move">${icon('arrow-left-right',16)} Kas masuk / keluar</button>`:`<p class="text-sm text-slate-500 mt-4">Masukkan modal kas awal sebelum mulai menerima pembayaran tunai.</p><button class="btn btn-primary w-full mt-5" data-action="open-shift">${icon('play',16)} Buka shift</button>`}
      </section><section class="bento p-5"><h3 class="font-extrabold">Panduan rekonsiliasi</h3><div class="space-y-4 mt-4">${[['Modal awal','Uang tunai yang tersedia di laci saat shift dimulai.'],['Kas masuk / keluar','Catat tambahan modal atau biaya yang dibayar dari laci kas.'],['Kas seharusnya','Modal awal + penerimaan tunai − kembalian + kas masuk − kas keluar.'],['Selisih kas','Kas fisik saat tutup dikurangi kas seharusnya.']].map((x,i)=>`<div class="flex gap-3"><div class="h-7 w-7 rounded-lg ${['bg-mint','bg-lavender','bg-lemon','bg-coral'][i]} grid place-items-center font-extrabold text-xs">${i+1}</div><div><div class="font-bold text-sm">${x[0]}</div><p class="text-xs text-slate-500 mt-1">${x[1]}</p></div></div>`).join('')}</div></section></div>`;
  }
  function renderHistory() {
    const rows = state.history || [];
    return `<div class="mb-4"><h1 class="text-2xl font-extrabold">Riwayat transaksi</h1><p class="text-sm text-slate-500 mt-1">Cari dan cetak ulang struk transaksi.</p></div><div class="bento overflow-hidden"><div class="p-3 border-b border-slate-100 flex gap-2"><input id="history-filter" class="field" placeholder="Cari nomor invoice / pelanggan…"><button class="btn" data-action="refresh-history">${icon('refresh-cw',16)}</button></div><div id="history-rows">${rows.length?rows.map(t=>historyRow(t)).join(''):`<div class="p-10 text-center text-sm text-slate-400">Memuat riwayat…</div>`}</div></div>`;
  }
  function historyRow(t) { return `<div class="table-row history-row" data-search="${esc([t.invoice_no,t.customer_name,t.cashier_name].join(' ').toLowerCase())}"><div class="min-w-0"><div class="font-extrabold text-sm truncate">${esc(t.invoice_no)}</div><div class="mobile-sub text-[10px] text-slate-400">${fmtDate(t.timestamp,true)} · ${esc(t.customer_name||'Umum')}</div><div class="desk-col text-xs text-slate-400">${fmtDate(t.timestamp,true)} · ${esc(t.cashier_name||'')}</div></div><div class="desk-col text-right text-xs text-slate-500">${esc(t.payment_method)}</div><div class="row-amount flex items-center justify-end gap-2"><span class="mono font-extrabold text-sm">${money(t.grand_total)}</span><button class="btn p-2" data-reprint="${esc(t.trx_id)}">${icon('printer',15)}</button></div></div>`; }

  function renderAi() {
    const keyExists = !!localStorage.getItem(STORAGE.geminiKey);
    const model = localStorage.getItem(STORAGE.geminiModel) || state.settings.active_gemini_model || 'gemini-3.5-flash-lite';
    const prompts = [ ['Analisis profit & produk terlaris','Analisis profit dan produk terlaris berdasarkan data toko. Tunjukkan produk margin tinggi dan produk yang perlu dievaluasi.'], ['Prediksi restock','Analisis stok kritis dan sarankan prioritas serta jumlah restock.'], ['Strategi promo & bundling','Buat strategi promo dan bundling pelanggan berdasarkan produk terlaris dan pelanggan berulang.'], ['Tanya data toko','Berikan ringkasan kondisi bisnis dan tiga tindakan paling penting.'] ];
    return `<div class="flex flex-wrap justify-between items-end gap-3 mb-4"><div><span class="pill bg-lavender">BYOK · GEMINI</span><h1 class="text-2xl font-extrabold mt-2">AI Business Copilot</h1><p class="text-sm text-slate-500 mt-1">Tanya data toko dan ubah angka menjadi keputusan.</p></div><button class="btn" data-action="ai-settings">${icon('key-round',16)} API Key</button></div>
      <div class="grid lg:grid-cols-[.8fr_1.2fr] gap-4"><section class="space-y-3"><div class="bento p-4"><div class="flex items-center justify-between"><div><div class="font-extrabold">Status koneksi</div><div class="text-xs text-slate-500 mt-1">${keyExists?'API key tersimpan di browser ini':'API key belum disetel'}</div></div><span class="pill ${keyExists?'bg-mint':'bg-lemon'}">${keyExists?'READY':'SETUP'}</span></div><div class="mt-4"><label class="label">Model Gemini</label><select id="ai-model" class="field"><option value="gemini-3.5-flash-lite" ${model==='gemini-3.5-flash-lite'?'selected':''}>Gemini 3.5 Flash-Lite · cepat</option><option value="gemini-3.1-flash-lite" ${model==='gemini-3.1-flash-lite'?'selected':''}>Gemini 3.1 Flash-Lite · reasoning</option></select></div><button class="btn w-full mt-3" data-action="test-ai">${icon('plug-zap',16)} Test koneksi</button></div>
      <div class="bento p-4"><h3 class="font-extrabold">Quick actions</h3><div class="grid gap-2 mt-3">${prompts.map((p,i)=>`<button class="text-left rounded-xl border border-slate-200 p-3 hover:bg-cream" data-ai-prompt="${i}"><div class="font-bold text-sm">${['📊','📦','🎯','💬'][i]} ${p[0]}</div><div class="text-xs text-slate-500 mt-1">Jalankan analisis otomatis</div></button>`).join('')}</div></div></section>
      <section class="bento p-4 min-h-[460px] flex flex-col"><div class="flex items-center justify-between border-b border-slate-100 pb-3"><div><h3 class="font-extrabold">Percakapan bisnis</h3><p class="text-xs text-slate-500">Konteks dari ringkasan transaksi & stok</p></div><button class="btn btn-ghost p-2" data-action="clear-ai">${icon('trash-2',16)}</button></div><div id="ai-chat" class="flex-1 overflow-y-auto py-3 space-y-3 min-h-[260px]">${state.aiMessages.length?state.aiMessages.map(m=>`<div class="flex ${m.role==='user'?'justify-end':''}"><div class="max-w-[90%] rounded-2xl px-3 py-2 text-sm ${m.role==='user'?'bg-ink text-white':'bg-slate-100 text-ink'}">${esc(m.text).replace(/\n/g,'<br>')}</div></div>`).join(''):`<div class="text-center py-16"><div class="text-4xl">✨</div><p class="font-extrabold mt-3">Apa yang ingin Anda ketahui?</p><p class="text-xs text-slate-500 mt-1">Mulai dari quick action atau tulis pertanyaan.</p></div>`}</div><form id="ai-chat-form" class="flex gap-2 border-t border-slate-100 pt-3"><input id="ai-question" class="field" placeholder="Contoh: produk apa yang perlu direstock?" autocomplete="off"><button class="btn btn-dark" type="submit" ${state.aiBusy?'disabled':''}>${icon('send',16)}</button></form></section></div>`;
  }
  function renderUsers() {
    const users=state.users||[];
    return `<div class="flex flex-wrap justify-between items-end gap-3 mb-4"><div><h1 class="text-2xl font-extrabold">Pengguna & akses</h1><p class="text-sm text-slate-500 mt-1">Atur akun, peran, dan PIN pergantian kasir.</p></div><button class="btn btn-primary" data-action="add-user">${icon('user-plus',16)} Tambah pengguna</button></div><div class="bento overflow-hidden">${users.map(u=>`<div class="table-row"><div class="flex items-center gap-3 min-w-0"><div class="h-9 w-9 rounded-xl bg-sky grid place-items-center font-extrabold">${esc(u.full_name.slice(0,1).toUpperCase())}</div><div class="min-w-0"><div class="font-extrabold text-sm truncate">${esc(u.full_name)}</div><div class="text-xs text-slate-400">@${esc(u.username)}</div></div></div><div class="desk-col text-right"><span class="pill ${u.role==='owner'?'bg-lavender':u.role==='manager'?'bg-lemon':'bg-slate-100'}">${roleName(u.role)}</span></div><div class="row-amount text-right"><span class="pill bg-mint">Aktif</span></div></div>`).join('')||`<div class="p-10 text-center text-sm text-slate-400">Belum ada pengguna.</div>`}</div>`;
  }
  function renderSettings() {
    return `<div class="mb-4"><h1 class="text-2xl font-extrabold">Pengaturan toko</h1><p class="text-sm text-slate-500 mt-1">Identitas toko, pajak, dan koneksi backend aplikasi.</p></div><form id="settings-form" class="grid lg:grid-cols-2 gap-4"><section class="bento p-4 space-y-3"><h3 class="font-extrabold">Identitas toko</h3><div><label class="label">Nama toko</label><input name="store_name" class="field" value="${esc(state.settings.store_name||'')}"></div><div><label class="label">Alamat</label><textarea name="store_address" class="field" rows="2">${esc(state.settings.store_address||'')}</textarea></div><div><label class="label">Nomor telepon</label><input name="store_phone" class="field" value="${esc(state.settings.store_phone||'')}"></div><div><label class="label">Footer struk</label><input name="receipt_footer" class="field" value="${esc(state.settings.receipt_footer||'')}"></div></section><section class="bento p-4 space-y-3"><h3 class="font-extrabold">Konfigurasi sistem</h3><div><label class="label">Google Apps Script Web App URL</label><input id="settings-api-url" class="field text-xs" value="${esc(state.apiUrl)}" type="url"></div><div><label class="label">Pajak default (%)</label><input name="tax_percent" class="field" type="number" min="0" step="0.01" value="${esc(state.settings.tax_percent||'0')}"></div><div><label class="label">Lebar printer thermal</label><select name="printer_width" class="field"><option value="58" ${state.settings.printer_width==='58'?'selected':''}>58 mm</option><option value="80" ${state.settings.printer_width==='80'?'selected':''}>80 mm</option></select></div><label class="flex gap-2 items-center text-sm"><input type="checkbox" name="allow_negative_stock" ${String(state.settings.allow_negative_stock)==='true'?'checked':''}> Izinkan stok negatif</label><button class="btn btn-primary w-full" type="submit">${icon('save',16)} Simpan pengaturan</button></section></form>
      <div class="bento p-4 mt-4"><div class="flex justify-between items-center"><div><h3 class="font-extrabold">Gemini AI Copilot</h3><p class="text-xs text-slate-500 mt-1">API key disimpan di localStorage browser, bukan di Google Sheets.</p></div><button class="btn" data-action="ai-settings">Atur API Key</button></div></div>`;
  }

  function openModal(title, body, opts = {}) { state.modal = { title, body, wide:!!opts.wide, subtitle:opts.subtitle||'' }; render(); }
  function closeModal() { stopCamera(); state.modal = null; render(); }
  function renderModal() {
    if (!state.modal) return '';
    return `<div class="modal-backdrop" data-action="close-modal"><section class="modal-sheet ${state.modal.wide?'md:max-w-2xl':''}" data-stop-click><div class="flex items-start justify-between gap-3 mb-4"><div><h3 class="text-lg font-extrabold">${esc(state.modal.title)}</h3>${state.modal.subtitle?`<p class="text-xs text-slate-500 mt-1">${esc(state.modal.subtitle)}</p>`:''}</div><button class="btn p-2" data-action="close-modal">${icon('x',17)}</button></div>${state.modal.body}</section></div>`;
  }
  function productForm(p = {}) {
    const categoryOptions = state.catalog.categories.map(c=>`<option value="${esc(c.category_id)}" ${p.category_id===c.category_id?'selected':''}>${esc(c.name)}</option>`).join('');
    return `<form id="product-form" class="grid grid-cols-2 gap-3"><input type="hidden" name="product_id" value="${esc(p.product_id||'')}"><div class="col-span-2"><label class="label">Nama produk *</label><input name="name" class="field" required value="${esc(p.name||'')}"></div><div><label class="label">SKU</label><input name="sku" class="field" value="${esc(p.sku||'')}"></div><div><label class="label">Barcode</label><div class="flex gap-1"><input name="barcode" class="field" value="${esc(p.barcode||'')}"><button type="button" class="btn p-2" data-action="camera-scan-product" title="Scan barcode">${icon('scan-line',16)}</button></div></div><div><label class="label">Kategori</label><select name="category_id" class="field"><option value="">Tanpa kategori</option>${categoryOptions}</select></div><div><label class="label">Satuan</label><input name="unit" class="field" value="${esc(p.unit||'pcs')}"></div><div><label class="label">Harga modal</label><input name="buy_price" class="field" type="number" min="0" value="${Number(p.buy_price||0)}"></div><div><label class="label">Harga jual *</label><input name="sell_price" class="field" type="number" min="0" required value="${Number(p.sell_price||0)}"></div><div><label class="label">Harga member</label><input name="member_price" class="field" type="number" min="0" value="${Number(p.member_price||0)}"></div><div><label class="label">Pajak (%)</label><input name="tax_rate" class="field" type="number" min="0" step="0.01" value="${Number(p.tax_rate??state.settings.tax_percent??0)}"></div><div><label class="label">Stok</label><input name="stock" class="field" type="number" step="any" value="${Number(p.stock||0)}"></div><div><label class="label">Minimum stok</label><input name="min_stock" class="field" type="number" step="any" value="${Number(p.min_stock||0)}"></div><div class="col-span-2 flex justify-end gap-2 pt-2"><button type="button" class="btn" data-action="close-modal">Batal</button><button class="btn btn-primary" type="submit">${icon('save',15)} Simpan produk</button></div></form>`;
  }
  function customerForm(c = {}) {
    return `<form id="customer-form" class="space-y-3"><input type="hidden" name="customer_id" value="${esc(c.customer_id||'')}"><div><label class="label">Nama pelanggan *</label><input name="name" class="field" required value="${esc(c.name||'')}"></div><div><label class="label">Nomor telepon / WhatsApp</label><input name="phone" class="field" inputmode="tel" value="${esc(c.phone||'')}"></div><div><label class="label">Email</label><input name="email" type="email" class="field" value="${esc(c.email||'')}"></div><div><label class="label">Catatan</label><textarea name="notes" class="field" rows="2">${esc(c.notes||'')}</textarea></div><div class="flex justify-end gap-2"><button type="button" class="btn" data-action="close-modal">Batal</button><button class="btn btn-primary" type="submit">Simpan pelanggan</button></div></form>`;
  }
  function openCheckout() {
    if (!state.cart.length) return showToast('Keranjang masih kosong.','warning');
    const totals = calcCartTotals();
    openModal('Pembayaran', `<div class="rounded-xl bg-cream p-4 mb-4"><div class="text-xs text-slate-500">Total tagihan (estimasi termasuk pajak)</div><div class="mono text-2xl font-extrabold mt-1">${money(totals.grand)}</div><div class="text-xs text-slate-500 mt-2">${cartQty()} item · Subtotal ${money(totals.subtotal)} · Pajak ${money(totals.tax)}</div></div>
      <form id="checkout-form" class="space-y-3"><div><label class="label">Metode pembayaran utama</label><select name="method" id="pay-method" class="field"><option>Tunai</option><option>QRIS</option><option>Transfer</option><option>Kartu</option><option>Kasbon</option></select></div><div id="pay-primary-wrap"><label class="label">Nominal diterima</label><input id="pay-primary" name="primary_amount" type="number" min="0" class="field mono" value="${Math.round(totals.grand)}"></div><div class="rounded-xl border border-slate-200 p-3"><label class="flex items-center gap-2 text-sm font-bold"><input id="split-toggle" type="checkbox"> Tambahkan pembayaran kedua</label><div id="split-fields" class="hidden grid grid-cols-2 gap-2 mt-3"><div><label class="label">Metode kedua</label><select name="split_method" class="field"><option>QRIS</option><option>Tunai</option><option>Transfer</option><option>Kartu</option></select></div><div><label class="label">Nominal kedua</label><input name="split_amount" type="number" min="0" value="0" class="field mono"></div></div></div><div class="rounded-xl bg-lemon/50 p-3 text-xs text-slate-600">Jika jumlah pembayaran kurang dari total, sisa tagihan akan dicatat sebagai Kasbon dan wajib memilih pelanggan. Kembalian hanya dihitung untuk pembayaran tunai tunggal.</div><div class="flex justify-between gap-2 pt-2"><button type="button" class="btn" data-action="close-modal">Batal</button><button class="btn btn-primary flex-1" type="submit">Konfirmasi pembayaran ${icon('arrow-right',16)}</button></div></form>`, { subtitle: 'Transaksi akan mengurangi stok setelah dikonfirmasi.' });
    $('#split-toggle')?.addEventListener('change', e => $('#split-fields')?.classList.toggle('hidden', !e.target.checked));
    $('#pay-method')?.addEventListener('change', e => {
      const isDebt = e.target.value === 'Kasbon';
      $('#pay-primary-wrap')?.classList.toggle('hidden', isDebt);
      if (isDebt) { $('#pay-primary').value = '0'; $('#split-toggle').checked = false; $('#split-toggle').disabled = true; $('#split-fields')?.classList.add('hidden'); }
      else { $('#split-toggle').disabled = false; if (Number($('#pay-primary').value) === 0) $('#pay-primary').value = Math.round(calcCartTotals().grand); }
    });
  }
  function calcCartTotals() {
    let subtotal=0, rawTax=0;
    state.cart.forEach(item=>{const p=productById(item.product_id);const base=Math.max(0,Number(item.price||p?.sell_price||0)*Number(item.qty||0)-Number(item.discount||0));subtotal+=base;const rate=(p?.tax_rate===undefined||p?.tax_rate===null||p?.tax_rate==='')?Number(state.settings.tax_percent||0):Number(p.tax_rate);rawTax+=base*Math.max(0,rate)/100;});
    const discount=Math.min(subtotal,Math.max(0,Number(window._posDiscount||0)));
    const ratio=subtotal?((subtotal-discount)/subtotal):1;
    const tax=rawTax*ratio;return {subtotal,discount,tax,grand:Math.max(0,Math.round(subtotal-discount+tax))};
  }
  function openProduct(p) { openModal(p?'Edit produk':'Tambah produk',productForm(p||{}),{wide:true}); }
  function openCategory() { openModal('Tambah kategori',`<form id="category-form" class="space-y-3"><div><label class="label">Nama kategori</label><input name="name" class="field" required></div><div class="grid grid-cols-2 gap-2"><div><label class="label">Ikon / emoji</label><input name="icon" class="field" value="▦"></div><div><label class="label">Warna</label><input name="color_hex" type="color" class="field h-11" value="#DDD6FE"></div></div><div><label class="label">Urutan</label><input name="sort_order" type="number" class="field" value="0"></div><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Simpan kategori</button></div></form>`); }
  function openDebtPayment(id) { const d=(state.debts||[]).find(x=>x.debt_id===id);if(!d)return;openModal('Terima pembayaran piutang',`<div class="rounded-xl bg-cream p-3 mb-3"><div class="font-extrabold">${esc(d.customer_name)}</div><div class="text-xs text-slate-500 mt-1">${esc(d.invoice_no||'')}</div><div class="mono text-xl font-extrabold mt-2">Sisa ${money(d.outstanding_amount)}</div></div><form id="debt-pay-form" class="space-y-3"><input type="hidden" name="debt_id" value="${esc(id)}"><div><label class="label">Nominal dibayar</label><input name="amount" type="number" min="1" max="${Number(d.outstanding_amount)}" value="${Number(d.outstanding_amount)}" class="field mono" required></div><div><label class="label">Metode</label><select name="method" class="field"><option>Tunai</option><option>QRIS</option><option>Transfer</option></select></div><div><label class="label">Catatan</label><input name="note" class="field"></div><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Simpan pembayaran</button></div></form>`); }
  function openCustomer(c) { openModal(c?'Edit pelanggan':'Tambah pelanggan',customerForm(c||{})); }
  function openStockAdjust(p) {
    openModal('Penyesuaian stok', `<div class="rounded-xl bg-cream p-3 mb-3"><div class="font-extrabold">${esc(p.name)}</div><div class="text-xs text-slate-500 mt-1">Stok saat ini: <b>${p.stock} ${esc(p.unit||'pcs')}</b></div></div><form id="stock-form" class="space-y-3"><input type="hidden" name="product_id" value="${esc(p.product_id)}"><div><label class="label">Stok fisik hasil opname</label><input name="counted_stock" class="field" type="number" step="any" min="0" required value="${Number(p.stock)}"></div><div><label class="label">Catatan</label><input name="note" class="field" placeholder="Contoh: Stock opname rak depan"></div><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Simpan penyesuaian</button></div></form>`);
  }
  function openUser() {
    openModal('Tambah pengguna', `<form id="user-form" class="space-y-3"><div><label class="label">Nama lengkap</label><input name="full_name" class="field" required></div><div><label class="label">Username (minimal 3 karakter)</label><input name="username" class="field" pattern="[a-zA-Z0-9._-]{3,60}" required></div><div><label class="label">Peran</label><select name="role" class="field"><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div><div><label class="label">Password (minimal 10 karakter)</label><input name="password" class="field" type="password" minlength="10" required></div><div><label class="label">PIN (4–6 digit)</label><input name="pin" class="field" type="password" inputmode="numeric" pattern="[0-9]{4,6}" required></div><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Buat akun</button></div></form>`,{subtitle:'Password dan PIN akan di-hash di browser sebelum dikirim.'});
  }
  function openAISettings() {
    const key=localStorage.getItem(STORAGE.geminiKey)||'';
    openModal('Pengaturan Gemini BYOK', `<form id="ai-settings-form" class="space-y-3"><div class="rounded-xl bg-lemon/50 p-3 text-xs text-slate-700">API key disimpan pada localStorage browser ini. Jangan gunakan browser bersama atau perangkat publik.</div><div><label class="label">Google AI Studio API Key</label><input name="api_key" class="field" type="password" autocomplete="off" value="${esc(key)}" placeholder="AIza…"></div><div><label class="label">Model</label><select name="model" class="field"><option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite</option><option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option></select></div><div class="flex justify-between gap-2"><button type="button" class="btn btn-danger" data-action="clear-ai-key">Hapus key</button><button type="submit" class="btn btn-primary">Simpan</button></div></form>`);
    const sel=$('[name="model"]'); if(sel) sel.value=localStorage.getItem(STORAGE.geminiModel)||'gemini-3.5-flash-lite';
  }
  function openShiftModal() {
    if (state.shift) return openModal('Tutup shift', `<form id="shift-close-form" class="space-y-3"><div class="rounded-xl bg-cream p-3"><div class="text-xs text-slate-500">Modal awal</div><div class="mono text-xl font-extrabold">${money(state.shift.opening_cash)}</div><div class="text-xs text-slate-500 mt-1">Mulai ${fmtDate(state.shift.opened_at,true)}</div></div><div><label class="label">Uang tunai fisik di laci</label><input name="actual_cash" class="field mono" type="number" min="0" required></div><p class="text-xs text-slate-500">Sistem akan membandingkan kas fisik dengan kas seharusnya.</p><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Tutup shift</button></div></form>`);
    openModal('Buka shift', `<form id="shift-open-form" class="space-y-3"><div><label class="label">Modal kas awal</label><input name="opening_cash" class="field mono" type="number" min="0" value="0" required></div><p class="text-xs text-slate-500">Masukkan jumlah uang tunai yang tersedia di laci kas.</p><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Buka shift</button></div></form>`);
  }
  function openCashMove() {
    openModal('Kas masuk / keluar', `<form id="cash-move-form" class="space-y-3"><div><label class="label">Jenis</label><select name="type" class="field"><option value="in">Kas masuk</option><option value="out">Kas keluar</option></select></div><div><label class="label">Nominal</label><input name="amount" type="number" min="1" class="field mono" required></div><div><label class="label">Keterangan</label><input name="description" class="field" required placeholder="Contoh: beli kantong plastik"></div><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Simpan</button></div></form>`);
  }

  function bindShell() {
    const root=$('#app');
    root.onclick=handleClick; root.onsubmit=handleSubmit; root.oninput=handleInput; root.onchange=handleChange;
    if (state.page==='pos') {
      $('#product-search')?.focus({preventScroll:true});
    }
    if (state.page==='ai') { const chat=$('#ai-chat'); if(chat) chat.scrollTop=chat.scrollHeight; }
  }
  function handleClick(e) {
    const stop=e.target.closest('[data-stop-click]'); if(stop && !e.target.closest('[data-action]') && !e.target.closest('[data-page]') && !e.target.closest('[data-add-product]') && !e.target.closest('[data-qty]') && !e.target.closest('[data-ai-prompt]') && !e.target.closest('[data-edit-product]') && !e.target.closest('[data-adjust-stock]') && !e.target.closest('[data-reprint]') && !e.target.closest('[data-resume-held]')) return;
    const pageEl=e.target.closest('[data-page]');
    if(pageEl && pageEl.dataset.page && pageEl.dataset.page!=='more') { e.preventDefault(); goPage(pageEl.dataset.page); return; }
    const cat=e.target.closest('[data-category]'); if(cat){state.category=cat.dataset.category;render();return;}
    const add=e.target.closest('[data-add-product]'); if(add){addToCart(add.dataset.addProduct);return;}
    const qty=e.target.closest('[data-qty]'); if(qty){changeQty(qty.dataset.qty,Number(qty.dataset.delta));return;}
    const edit=e.target.closest('[data-edit-product]'); if(edit){openProduct(productById(edit.dataset.editProduct));return;}
    const adjust=e.target.closest('[data-adjust-stock]'); if(adjust){openStockAdjust(productById(adjust.dataset.adjustStock));return;}
    const reprint=e.target.closest('[data-reprint]'); if(reprint){reprintReceipt(reprint.dataset.reprint);return;}
    const aiPrompt=e.target.closest('[data-ai-prompt]'); if(aiPrompt){runAIQuick(Number(aiPrompt.dataset.aiPrompt));return;}
    const preset=e.target.closest('[data-preset]'); if(preset){applyPreset(preset.dataset.preset);return;}
    const resume=e.target.closest('[data-resume-held]'); if(resume){resumeHeld(resume.dataset.resumeHeld);return;}
    const payDebt=e.target.closest('[data-pay-debt]'); if(payDebt){openDebtPayment(payDebt.dataset.payDebt);return;}
    const actionEl=e.target.closest('[data-action]'); if(!actionEl)return;
    const action=actionEl.dataset.action;
    switch(action){
      case 'logout': logout(); break;
      case 'more': openMoreMenu(); break;
      case 'open-cart': state.cartOpen=true;loadCustomers().finally(render); break;
      case 'close-cart': state.cartOpen=false; render(); break;
      case 'close-modal': closeModal(); break;
      case 'clear-search': state.search='';render();break;
      case 'refresh-catalog': refreshCatalog().then(()=>{render();showToast('Katalog diperbarui.');}).catch(err=>showToast(err.message,'error'));break;
      case 'refresh-dashboard': loadDashboard(true);break;
      case 'add-product': openProduct();break;
      case 'add-category': openCategory();break;
      case 'refresh-debts': loadDebts();break;
      case 'camera-scan-product': state.scanTarget='product-barcode';state.scanReturnModal=state.modal;openCamera();break;
      case 'add-customer': openCustomer();break;
      case 'quick-customer': openCustomer();break;
      case 'add-user': openUser();break;
      case 'add-expense': openExpense();break;
      case 'checkout': state.cartOpen=false;openCheckout();break;
      case 'clear-cart': state.cart=[];window._posDiscount=0;persistCart();render();break;
      case 'hold-cart': holdCart();break;
      case 'show-held': showHeld();break;
      case 'camera-scan': openCamera();break;
      case 'open-shift': state.shift?openShiftModal():openShiftModal();break;
      case 'close-shift': openShiftModal();break;
      case 'cash-move': openCashMove();break;
      case 'run-report': runReport();break;
      case 'export-report': exportReport();break;
      case 'refresh-history': loadHistory();break;
      case 'ai-settings': openAISettings();break;
      case 'test-ai': testAI();break;
      case 'clear-ai': state.aiMessages=[];render();break;
      case 'clear-ai-key': localStorage.removeItem(STORAGE.geminiKey);localStorage.removeItem(STORAGE.geminiModel);closeModal();showToast('API key dihapus dari browser.');break;
      default: break;
    }
  }
  function handleInput(e) {
    const t=e.target;
    if(t.id==='product-search'){state.search=t.value;filterProductGrid();}
    if(t.id==='cart-discount'){window._posDiscount=Math.max(0,Number(t.value||0));$$('.cart-total').forEach(el=>el.textContent=money(calcCartTotals().grand));}
    if(t.id==='products-filter') filterRows('#products-rows','.product-row',t.value);
    if(t.id==='customer-search') filterRows('#customer-rows','.customer-row',t.value);
    if(t.id==='inventory-filter') filterRows('#inventory-rows','.inventory-row',t.value);
    if(t.id==='history-filter') filterRows('#history-rows','.history-row',t.value);
  }
  function filterRows(parent,selector,q){const root=$(parent);if(!root)return;const value=String(q||'').toLowerCase();$$(selector,root).forEach(row=>row.classList.toggle('hidden',!row.dataset.search.includes(value)));}
  function filterProductGrid(){const root=$('#product-list');if(!root)return;const products=(state.catalog.products||[]).filter(p=>(String(p.name||'').toLowerCase().includes(state.search.toLowerCase())||String(p.barcode||'').includes(state.search)||String(p.sku||'').toLowerCase().includes(state.search.toLowerCase()))&&(state.category==='all'||String(p.category_id)===String(state.category)));root.innerHTML=products.map((p,i)=>`<button class="product-card" data-add-product="${esc(p.product_id)}" ${Number(p.stock)<=0&&String(state.settings.allow_negative_stock)!=='true'?'disabled':''}><div class="flex items-start justify-between gap-2"><div class="product-tile ${['bg-mint','bg-lavender','bg-lemon','bg-sky','bg-coral'][i%5]}">▦</div><span class="pill ${Number(p.stock)<=Number(p.min_stock)?'bg-coral':'bg-slate-100'}">${p.stock} ${esc(p.unit||'pcs')}</span></div><div class="font-extrabold text-sm mt-3 line-clamp-2 min-h-10">${esc(p.name)}</div><div class="text-[10px] text-slate-400 mt-1">${esc(p.sku||p.barcode||'')}</div><div class="mono font-extrabold mt-2">${money(p.sell_price)}</div></button>`).join('')||'<div class="col-span-full p-8 text-center text-sm text-slate-400">Produk tidak ditemukan.</div>';refreshIcons();}
  function handleChange(e) {
    const t=e.target;
    if(t.id==='cart-customer'){state.selectedCustomer=state.customers.find(c=>c.customer_id===t.value)||null;}
    if(t.id==='ai-model'){localStorage.setItem(STORAGE.geminiModel,t.value);}
  }
  async function handleSubmit(e) {
    const form=e.target; if(!form.id)return;
    e.preventDefault(); const data=Object.fromEntries(new FormData(form).entries());
    try {
      switch(form.id){
        case 'product-form': {
          for(const k of ['buy_price','sell_price','member_price','stock','min_stock','tax_rate']) data[k]=Number(data[k]||0);
          const result=await api('products.save',data); await refreshCatalog();closeModal();showToast('Produk tersimpan.');break;
        }
        case 'customer-form': {
          const result=await api('customers.save',data);await loadCustomers();closeModal();showToast('Pelanggan tersimpan.');break;
        }
        case 'category-form': {await api('categories.save',data);await refreshCatalog();closeModal();render();showToast('Kategori tersimpan.');break;}
        case 'debt-pay-form': {await api('debt.pay',{debt_id:data.debt_id,amount:Number(data.amount),method:data.method,note:data.note});await loadDebts();closeModal();showToast('Pembayaran piutang dicatat.');break;}
        case 'user-form': {
          if(data.password.length<10)throw new Error('Password minimal 10 karakter.');if(!/^\d{4,6}$/.test(data.pin))throw new Error('PIN harus 4–6 digit.');
          const payload={username:data.username,full_name:data.full_name,role:data.role,passwordHash:await sha256Hex(data.password),pinHash:await sha256Hex(data.pin)};
          await api('users.save',payload);await loadUsers();closeModal();showToast('Pengguna berhasil dibuat.');break;
        }
        case 'stock-form': {
          data.counted_stock=Number(data.counted_stock);await api('inventory.adjust',data);await refreshCatalog();closeModal();render();showToast('Stok berhasil disesuaikan.');break;
        }
        case 'checkout-form': await submitCheckout(data,form);break;
        case 'shift-open-form': await api('shifts.open',{opening_cash:Number(data.opening_cash)});await refreshShift();closeModal();render();showToast('Shift berhasil dibuka.');break;
        case 'shift-close-form': {const result=await api('shifts.close',{actual_cash:Number(data.actual_cash)});await refreshShift();closeModal();render();openModal('Shift ditutup',`<div class="space-y-3"><div class="flex justify-between"><span class="text-sm text-slate-500">Kas seharusnya</span><b class="mono">${money(result.expected_cash)}</b></div><div class="flex justify-between"><span class="text-sm text-slate-500">Kas fisik</span><b class="mono">${money(result.actual_cash)}</b></div><div class="flex justify-between rounded-xl p-3 ${result.variance<0?'bg-coral':'bg-mint'}"><b>Selisih</b><b class="mono">${money(result.variance)}</b></div><button class="btn btn-primary w-full" data-action="close-modal">Selesai</button></div>`);break;}
        case 'cash-move-form': await api('cash.move',{...data,amount:Number(data.amount)});closeModal();showToast('Mutasi kas dicatat.');break;
        case 'expense-form': await api('expenses.save',{...data,amount:Number(data.amount)});await loadExpenses();closeModal();showToast('Pengeluaran dicatat.');break;
        case 'settings-form': {
          const payload={store_name:data.store_name,store_address:data.store_address,store_phone:data.store_phone,receipt_footer:data.receipt_footer,tax_percent:data.tax_percent,printer_width:data.printer_width,allow_negative_stock:form.elements.allow_negative_stock.checked?'true':'false'};
          const newUrl=$('#settings-api-url').value.trim();if(!/^https?:\/\//.test(newUrl))throw new Error('URL GAS tidak valid.');state.apiUrl=newUrl;localStorage.setItem(STORAGE.api,newUrl);
          state.settings=await api('settings.save',payload);saveJson(STORAGE.settings,state.settings);render();showToast('Pengaturan disimpan.');break;
        }
        case 'ai-settings-form': if(data.api_key.trim())localStorage.setItem(STORAGE.geminiKey,data.api_key.trim());else localStorage.removeItem(STORAGE.geminiKey);localStorage.setItem(STORAGE.geminiModel,data.model);closeModal();showToast('Pengaturan AI disimpan di browser.');break;
        case 'ai-chat-form': state.aiMessages.push({role:'user',text:data.question});render();await runAI(data.question);break;
        default: break;
      }
    } catch(err){showToast(err.message||'Terjadi kesalahan.','error');}
  }
  function openExpense(){openModal('Catat pengeluaran',`<form id="expense-form" class="space-y-3"><div><label class="label">Tanggal</label><input name="date_str" class="field" type="date" value="${isoDate(new Date())}" required></div><div><label class="label">Kategori</label><select name="category" class="field"><option>Operasional</option><option>Gaji</option><option>Transportasi</option><option>Utilitas</option><option>Persediaan</option><option>Lainnya</option></select></div><div><label class="label">Deskripsi</label><input name="description" class="field" required placeholder="Contoh: listrik toko"></div><div><label class="label">Nominal</label><input name="amount" class="field mono" type="number" min="1" required></div><div><label class="label">Metode pembayaran</label><select name="payment_method" class="field"><option>Tunai</option><option>Transfer</option><option>QRIS</option><option>Kartu</option></select></div><div class="flex justify-end gap-2"><button class="btn" type="button" data-action="close-modal">Batal</button><button class="btn btn-primary">Simpan pengeluaran</button></div></form>`);}

  async function submitCheckout(data) {
    const totals=calcCartTotals(); const method=data.method||'Tunai'; const customerId=$('#cart-customer')?.value || state.selectedCustomer?.customer_id || '';
    if(state.user.role==='cashier'&&!state.shift)throw new Error('Buka shift terlebih dahulu sebelum checkout.');
    let payments=[];
    if(method==='Kasbon') payments=[{method:'Kasbon',amount:totals.grand}];
    else {
      const primary=Math.max(0,Number(data.primary_amount||0)); payments.push({method,amount:primary});
      if($('#split-toggle')?.checked){const second=Math.max(0,Number(data.split_amount||0));if(second>0)payments.push({method:data.split_method||'QRIS',amount:second});}
      const received=payments.reduce((s,p)=>s+p.amount,0);
      if(received<totals.grand)payments.push({method:'Kasbon',amount:totals.grand-received});
    }
    if(payments.some(p=>p.method==='Kasbon')&&!customerId){throw new Error('Pilih pelanggan untuk mencatat sisa tagihan sebagai Kasbon.');}
    const items=state.cart.map(x=>({product_id:x.product_id,qty:Number(x.qty),discount:Number(x.discount||0)}));
    const payload={client_ref:crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`,items,customer_id:customerId,discount_amount:totals.discount,payments,notes:''};
    $('#app').querySelector('#checkout-form button[type="submit"]')?.setAttribute('disabled','disabled');
    let result;
    try {
      if(!navigator.onLine) throw new Error('Tidak dapat terhubung ke server.');
      result=await api('checkout',payload);
      const trx=result.transaction;
      const receiptItems=items.map(x=>{const p=productById(x.product_id);return {product_name:p?.name||'Produk',qty:x.qty,unit_price:Number(p?.sell_price||0),discount:x.discount,subtotal:x.qty*Number(p?.sell_price||0)-x.discount};});
      state.lastReceipt={transaction:trx,items:receiptItems,payments:result.payments||payments,outstanding:result.outstanding||0};
      state.cart=[];window._posDiscount=0;state.selectedCustomer=null;persistCart();
      await Promise.all([refreshCatalog().catch(()=>{}),refreshShift().catch(()=>{})]);
      closeModal();render();showToast(result.duplicate?'Transaksi sudah tersinkron sebelumnya.':'Transaksi berhasil disimpan.');
      showReceiptActions(state.lastReceipt);
    } catch(err) {
      if(String(err.message).includes('Tidak dapat terhubung')||!navigator.onLine){
        enqueueOffline(payload);state.cart=[];window._posDiscount=0;state.selectedCustomer=null;persistCart();closeModal();render();showToast('Transaksi disimpan di antrean offline. Akan disinkronkan saat online.','warning');
      } else { const button=$('#checkout-form button[type="submit"]');if(button)button.disabled=false;throw err; }
    }
  }
  function enqueueOffline(payload) {
    const queue=readJson(STORAGE.outbox,[]);queue.push({...payload,queued_at:new Date().toISOString()});saveJson(STORAGE.outbox,queue);
    // Reserve the items locally to reduce accidental overselling before sync.
    payload.items.forEach(line=>{const p=productById(line.product_id);if(p)p.stock=Math.max(0,Number(p.stock)-Number(line.qty));});saveJson(STORAGE.catalog,state.catalog);
  }
  async function syncOutbox() {
    if(state.syncBusy||!navigator.onLine||!state.token)return;state.syncBusy=true;
    try {
      const queue=readJson(STORAGE.outbox,[]);if(!queue.length)return;
      const remaining=[];
      for(let i=0;i<queue.length;i++){
        try{await api('checkout',queue[i]);}
        catch(err){remaining.push(...queue.slice(i));showToast(`Antrean offline belum tersinkron: ${err.message}`,'error');break;}
      }
      saveJson(STORAGE.outbox,remaining);
      if(!remaining.length){await refreshCatalog();showToast('Antrean offline berhasil disinkronkan.');}
    }catch(err){console.warn(err);}finally{state.syncBusy=false;}
  }
  function addToCart(productId) {
    const p=productById(productId);if(!p)return;
    const existing=state.cart.find(x=>x.product_id===productId);
    const nextQty=Number(existing?.qty||0)+1;
    if(String(state.settings.allow_negative_stock)!=='true' && nextQty>Number(p.stock))return showToast(Number(p.stock)<=0?'Stok produk habis.':`Stok ${p.name} hanya tersisa ${p.stock}.`,'warning');
    if(existing)existing.qty=nextQty;else state.cart.push({product_id:productId,qty:1,price:Number(p.sell_price),discount:0});
    persistCart();render();
  }
  function changeQty(productId,delta) {
    const item=state.cart.find(x=>x.product_id===productId);if(!item)return;
    const p=productById(productId);const nextQty=Number(item.qty)+Number(delta);
    if(delta>0 && String(state.settings.allow_negative_stock)!=='true' && nextQty>Number(p?.stock||0))return showToast(`Stok ${p?.name||'produk'} tidak mencukupi.`,'warning');
    item.qty=nextQty;if(item.qty<=0)state.cart=state.cart.filter(x=>x.product_id!==productId);
    persistCart();render();
  }
  async function holdCart() {
    if(!state.cart.length)return showToast('Keranjang kosong.','warning');
    const label=prompt('Nama pesanan / nomor meja:',`Pesanan ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`);if(label===null)return;
    const payload={label,customer_id:state.selectedCustomer?.customer_id||'',customer_name:state.selectedCustomer?.name||'',items:state.cart,created_at:new Date().toISOString()};
    try{await api('held.save',payload);state.cart=[];state.selectedCustomer=null;state.cartOpen=false;window._posDiscount=0;persistCart();render();showToast('Pesanan berhasil ditahan.');}catch(err){const held=readJson(STORAGE.held,[]);held.push({...payload,cart_id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),user_id:state.user.user_id});saveJson(STORAGE.held,held);state.cart=[];state.selectedCustomer=null;state.cartOpen=false;persistCart();render();showToast('Pesanan disimpan lokal karena offline.','warning');}
  }
  async function showHeld() {
    let held=[];try{held=await api('held.list');}catch(_){held=readJson(STORAGE.held,[]);}
    const body=held.length?held.map(h=>`<div class="flex items-center gap-2 border-b border-slate-100 py-3"><div class="flex-1 min-w-0"><div class="font-extrabold text-sm truncate">${esc(h.label)}</div><div class="text-xs text-slate-400">${esc(h.customer_name||'Pelanggan umum')} · ${fmtDate(h.updated_at||h.created_at,true)}</div></div><button class="btn btn-primary" data-resume-held="${esc(h.cart_id)}">Lanjutkan</button></div>`).join(''):`<div class="py-8 text-center text-sm text-slate-400">Belum ada pesanan tertahan.</div>`;
    state.heldData=held;openModal('Pesanan tertahan',body);
  }
  async function resumeHeld(id) {
    const h=(state.heldData||[]).find(x=>x.cart_id===id)||readJson(STORAGE.held,[]).find(x=>x.cart_id===id);if(!h)return;
    try{state.cart=JSON.parse(h.cart_json||'[]');}catch(_){state.cart=h.items||[];}
    if(!state.cart.length)return showToast('Isi keranjang tertahan tidak ditemukan.','error');
    state.selectedCustomer=state.customers.find(c=>c.customer_id===h.customer_id)||null;persistCart();
    try{await api('held.delete',{cart_id:id});}catch(_){saveJson(STORAGE.held,readJson(STORAGE.held,[]).filter(x=>x.cart_id!==id));}
    state.modal=null;state.cartOpen=true;render();
  }
  async function loadCustomers() {
    try{state.customers=await api('customers.list');saveJson('pos_customers',state.customers);}catch(err){state.customers=readJson('pos_customers',[]);if(!state.customers.length)console.warn(err);}
  }
  async function loadDashboard(force=false) {
    try{state.dashboard=await api('dashboard.summary',{});state.page='dashboard';render();}catch(err){showToast(err.message,'error');}
  }
  async function loadExpenses() {state.expenses=await api('expenses.list',{from:state.reportFrom,to:state.reportTo});render();}
  async function loadUsers(){state.users=await api('users.list');render();}
  async function loadDebts(){state.debts=await api('debts.list',{status:'open'});saveJson('pos_debts',state.debts);render();}
  async function loadHistory(){try{state.history=await api('transactions.list',{from:isoDate(new Date(Date.now()-30*86400000)),to:isoDate(new Date())});saveJson('pos_history',state.history);render();}catch(err){showToast(err.message,'error');}}
  async function goPage(page) {
    const allowed=allowedNav().some(n=>n.id===page);if(!allowed)return showToast('Menu ini tidak tersedia untuk peran Anda.','warning');
    state.page=page;state.modal=null;state.cartOpen=false;render();
    try{
      if(page==='dashboard'){state.dashboard=await api('dashboard.summary');render();}
      if(page==='pos'||page==='customers')await loadCustomers().then(render);
      if(page==='debts')await loadDebts().then(render);
      if(page==='reports'){if(!state.customers.length)await loadCustomers();await runReport(false);render();}
      if(page==='expenses'){state.expenses=await api('expenses.list',{from:state.reportFrom,to:state.reportTo});render();}
      if(page==='history'){state.history=await api('transactions.list',{from:isoDate(new Date(Date.now()-30*86400000)),to:isoDate(new Date())});saveJson('pos_history',state.history);render();}
      if(page==='users'){state.users=await api('users.list');render();}
      if(page==='settings'){state.settings=await api('settings.get');saveJson(STORAGE.settings,state.settings);render();}
      if(page==='shifts')await refreshShift().then(render);
      if(page==='inventory'||page==='products')await refreshCatalog().then(render);
    }catch(err){showToast(err.message,'error');}
  }
  function openMoreMenu(){
    const items=allowedNav().filter(n=>!['pos','products','reports'].includes(n.id));
    openModal('Menu lainnya',`<div class="grid grid-cols-2 gap-2">${items.map(n=>`<button class="bento-soft p-3 text-left" data-page="${n.id}"><div class="mb-2">${icon(n.icon,20)}</div><div class="font-extrabold text-sm">${n.label}</div></button>`).join('')}<button class="bento-soft p-3 text-left" data-action="logout"><div class="mb-2">${icon('log-out',20)}</div><div class="font-extrabold text-sm">Keluar</div></button></div>`);
  }

  async function runReport(renderAfter=true) {
    const from=$('#report-from')?.value||state.reportFrom;const to=$('#report-to')?.value||state.reportTo;
    state.reportFrom=from;state.reportTo=to;
    if($('#report-customer'))state.reportFilters.customer_id=$('#report-customer').value;
    if($('#report-payment'))state.reportFilters.payment_method=$('#report-payment').value;
    if($('#report-cashier'))state.reportFilters.cashier_id=$('#report-cashier').value;
    if($('#report-category'))state.reportFilters.category_id=$('#report-category').value;
    try{state.report=await api('reports.sales',{from,to,...state.reportFilters});if(renderAfter)render();}catch(err){showToast(err.message,'error');}
  }
  function applyPreset(preset) {
    const now=new Date();state.reportPreset=preset;
    if(preset==='today'){state.reportFrom=state.reportTo=isoDate(now);}
    if(preset==='yesterday'){const d=new Date(now);d.setDate(d.getDate()-1);state.reportFrom=state.reportTo=isoDate(d);}
    if(preset==='7d'){const d=new Date(now);d.setDate(d.getDate()-6);state.reportFrom=isoDate(d);state.reportTo=isoDate(now);}
    if(preset==='month'){state.reportFrom=isoDate(new Date(now.getFullYear(),now.getMonth(),1));state.reportTo=isoDate(now);}
    render();
  }
  function exportReport() {
    if(!state.report)return showToast('Jalankan laporan terlebih dahulu.','warning');
    const rows=[['Invoice','Tanggal','Pelanggan','Kasir','Subtotal','Diskon','Pajak','Total','Metode','Status']];
    state.report.transactions.forEach(t=>rows.push([t.invoice_no,t.timestamp,t.customer_name,t.cashier_name,t.subtotal,t.discount_amount,t.tax_amount,t.grand_total,t.payment_method,t.status]));
    const csv='\ufeff'+rows.map(row=>row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(';')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`laporan-penjualan-${state.reportFrom}-${state.reportTo}.csv`;a.click();URL.revokeObjectURL(url);
  }
  const AI_PROMPTS=[
    'Analisis profit dan produk terlaris. Temukan produk margin tinggi, produk berkontribusi rendah, dan tiga rekomendasi keputusan.',
    'Analisis stok kritis dan perputaran produk. Sarankan prioritas restock, jumlah yang masuk akal, dan risiko kehabisan stok.',
    'Buat strategi promo dan bundling untuk meningkatkan nilai transaksi dan pembelian ulang. Berikan contoh copy WhatsApp yang sopan.',
    'Buat ringkasan kondisi bisnis dari data toko saat ini. Apa tiga tindakan paling penting untuk pemilik toko?'
  ];
  function buildAIContext() {
    const products=(state.catalog.products||[]).map(p=>({name:p.name,category:(state.catalog.categories||[]).find(c=>c.category_id===p.category_id)?.name||'Lainnya',buy_price:Number(p.buy_price),sell_price:Number(p.sell_price),stock:Number(p.stock),min_stock:Number(p.min_stock)}));
    return {store:state.settings.store_name||'Toko',date:isoDate(new Date()),dashboard:state.dashboard||{},products:products.slice(0,300),selected_report:state.report?{from:state.report.from,to:state.report.to,summary:state.report.summary,top_products:state.report.top_products,categories:state.report.categories}:null,customers:(state.customers||[]).slice(0,100).map(c=>({name:c.name,total_spent:c.total_spent,visit_count:c.visit_count,tier:c.tier}))};
  }
  async function runAIQuick(index) { const q=AI_PROMPTS[index]||AI_PROMPTS[3];state.aiMessages.push({role:'user',text:q});render();await runAI(q); }
  async function runAI(question) {
    const key=localStorage.getItem(STORAGE.geminiKey);if(!key){showToast('Masukkan Gemini API Key terlebih dahulu.','warning');openAISettings();return;}
    const model=localStorage.getItem(STORAGE.geminiModel)||'gemini-3.5-flash-lite';state.aiBusy=true;
    const context=buildAIContext();
    try{
      const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:'Anda adalah konsultan bisnis ritel dan F&B Indonesia. Analisis hanya berdasarkan konteks data yang diberikan. Jelaskan asumsi bila data tidak cukup. Gunakan Bahasa Indonesia, ringkas, spesifik, dan jangan mengarang angka.'}]},contents:[{role:'user',parts:[{text:`KONTEKS DATA TOKO (JSON):\n${JSON.stringify(context)}\n\nPERTANYAAN:\n${question}`}]}],generationConfig:{temperature:0.35,maxOutputTokens:1200}})});
      const data=await res.json();if(!res.ok)throw new Error(data.error?.message||`Gemini API error (${res.status})`);
      const answer=(data.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('\n').trim()||'Model tidak mengembalikan teks.';
      state.aiMessages.push({role:'assistant',text:answer});
    }catch(err){state.aiMessages.push({role:'assistant',text:`Gagal menghubungi Gemini: ${err.message}`});}
    finally{state.aiBusy=false;render();}
  }
  async function testAI() {
    const key=localStorage.getItem(STORAGE.geminiKey);if(!key)return openAISettings();
    const model=localStorage.getItem(STORAGE.geminiModel)||'gemini-3.5-flash-lite';
    try{const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'Reply exactly: POS Copilot connected.'}]}],generationConfig:{maxOutputTokens:20}})});const d=await res.json();if(!res.ok)throw new Error(d.error?.message||'API error');showToast('Koneksi Gemini berhasil.');}catch(err){showToast(err.message,'error');}
  }

  async function reprintReceipt(trxId) {
    try{const data=await api('transactions.get',{trx_id:trxId});state.lastReceipt={transaction:data.transaction,items:data.items,payments:data.payments,outstanding:Math.max(0,Number(data.transaction.grand_total)-Number(data.transaction.amount_paid))};showReceiptActions(state.lastReceipt);}catch(err){showToast(err.message,'error');}
  }
  function showReceiptActions(receipt) {
    openModal('Transaksi berhasil', `<div class="rounded-xl bg-mint/60 p-4 text-center mb-4"><div class="text-3xl">✓</div><div class="font-extrabold text-lg mt-1">Pembayaran tercatat</div><div class="mono text-sm mt-1">${esc(receipt.transaction.invoice_no)}</div><div class="mono text-2xl font-extrabold mt-2">${money(receipt.transaction.grand_total)}</div></div><div class="grid grid-cols-2 gap-2"><button class="btn btn-primary" data-action="print-last-receipt">${icon('printer',16)} Cetak struk</button><button class="btn" data-action="share-last-receipt">${icon('message-circle',16)} WhatsApp</button><button class="btn col-span-2" data-action="close-modal">Selesai</button></div>`,{subtitle:'Struk dapat dicetak melalui printer Bluetooth atau browser.'});
  }
  function receiptText(receipt) {
    const t=receipt.transaction;const width=Number(state.settings.printer_width||58)===80?48:32;const line='-'.repeat(width);const center=s=>{s=String(s);return s.length>=width?s.slice(0,width):' '.repeat(Math.floor((width-s.length)/2))+s;};
    const moneyText=n=>new Intl.NumberFormat('id-ID',{maximumFractionDigits:0}).format(Number(n)||0);
    const out=[center(state.settings.store_name||'TOKO'),center(state.settings.store_address||''),center(state.settings.store_phone||''),line,`No: ${t.invoice_no}`,`Tgl: ${fmtDate(t.timestamp,true)}`,`Kasir: ${t.cashier_name||state.user.full_name}`,`Pelanggan: ${t.customer_name||'Umum'}`,line];
    (receipt.items||[]).forEach(i=>{out.push(String(i.product_name||'Item').slice(0,width));out.push(`${i.qty} x ${moneyText(i.unit_price)}${' '.repeat(Math.max(1,width-String(i.qty+' x '+moneyText(i.unit_price)).length-moneyText(i.subtotal).length))}${moneyText(i.subtotal)}`);});
    out.push(line,`Subtotal: ${moneyText(t.subtotal)}`,`Diskon: ${moneyText(t.discount_amount)}`,`Pajak: ${moneyText(t.tax_amount)}`,`TOTAL: ${moneyText(t.grand_total)}`,`Dibayar: ${moneyText(t.amount_paid)}`,`Kembali: ${moneyText(t.change_due)}`,`Metode: ${t.payment_method}`);
    if(receipt.outstanding>0)out.push(`Sisa Kasbon: ${moneyText(receipt.outstanding)}`);
    out.push(line,center(state.settings.receipt_footer||'Terima kasih!'),'','');return out.join('\n');
  }
  function browserPrintReceipt(receipt) {
    const t=receipt.transaction;const rows=(receipt.items||[]).map(i=>`<tr><td>${esc(i.product_name)}<small>${i.qty} × ${money(i.unit_price)}</small></td><td>${money(i.subtotal)}</td></tr>`).join('');
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>Struk ${esc(t.invoice_no)}</title><style>body{font:12px Arial,sans-serif;width:${Number(state.settings.printer_width||58)===80?'72mm':'52mm'};margin:0 auto;color:#111}h2,p{text-align:center;margin:4px 0}hr{border:0;border-top:1px dashed #333;margin:8px 0}table{width:100%;font-size:11px;border-collapse:collapse}td{padding:4px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}small{display:block;color:#555;margin-top:2px}.tot td{font-weight:bold}</style></head><body><h2>${esc(state.settings.store_name||'TOKO')}</h2><p>${esc(state.settings.store_address||'')}</p><p>${esc(state.settings.store_phone||'')}</p><hr><div>No: ${esc(t.invoice_no)}</div><div>${fmtDate(t.timestamp,true)}</div><div>Kasir: ${esc(t.cashier_name||'')}</div><div>Pelanggan: ${esc(t.customer_name||'Umum')}</div><hr><table>${rows}</table><hr><table><tr><td>Subtotal</td><td>${money(t.subtotal)}</td></tr><tr><td>Diskon</td><td>${money(t.discount_amount)}</td></tr><tr><td>Pajak</td><td>${money(t.tax_amount)}</td></tr><tr class="tot"><td>TOTAL</td><td>${money(t.grand_total)}</td></tr><tr><td>Dibayar</td><td>${money(t.amount_paid)}</td></tr><tr><td>Kembali</td><td>${money(t.change_due)}</td></tr></table><hr><p>${esc(state.settings.receipt_footer||'Terima kasih!')}</p><script>window.onload=()=>{window.print();setTimeout(()=>window.close(),500)};<\/script></body></html>`;
    const w=window.open('','_blank','width=420,height=700');if(!w)return showToast('Pop-up diblokir. Izinkan pop-up untuk cetak struk.','warning');w.document.open();w.document.write(html);w.document.close();
  }
  async function printLastReceipt() {
    if(!state.lastReceipt)return;const receipt=state.lastReceipt;
    if(!navigator.bluetooth){browserPrintReceipt(receipt);return;}
    const useBluetooth=confirm('Pilih OK untuk mencoba printer Bluetooth. Pilih Cancel untuk cetak via browser.');
    if(!useBluetooth){browserPrintReceipt(receipt);return;}
    try{await printBluetooth(receipt);showToast('Struk dikirim ke printer Bluetooth.');}catch(err){showToast(err.message,'error');if(confirm('Printer Bluetooth gagal. Gunakan Browser Print?'))browserPrintReceipt(receipt);}
  }
  async function printBluetooth(receipt) {
    const serviceUuid='000018f0-0000-1000-8000-00805f9b34fb';
    const device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[serviceUuid,'0000ff00-0000-1000-8000-00805f9b34fb']});
    const server=await device.gatt.connect();let characteristic=null;
    const serviceIds=[serviceUuid,'0000ff00-0000-1000-8000-00805f9b34fb'];
    for(const sid of serviceIds){try{const service=await server.getPrimaryService(sid);const chars=await service.getCharacteristics();characteristic=chars.find(c=>c.properties.writeWithoutResponse||c.properties.write);if(characteristic)break;}catch(_){} }
    if(!characteristic)throw new Error('Karakteristik tulis printer tidak ditemukan. Periksa UUID/kompatibilitas printer.');
    const bytes=new EscPosEncoder().encode(receiptText(receipt));
    for(let offset=0;offset<bytes.length;offset+=20){const chunk=bytes.slice(offset,offset+20);if(characteristic.writeValueWithoutResponse&&characteristic.properties.writeWithoutResponse)await characteristic.writeValueWithoutResponse(chunk);else await characteristic.writeValue(chunk);await new Promise(r=>setTimeout(r,20));}
    try{device.gatt.disconnect();}catch(_){}
  }
  class EscPosEncoder {
    constructor(){this.parts=[];this.encoder=new TextEncoder();}
    bytes(a){this.parts.push(new Uint8Array(a));return this;}
    text(s){this.parts.push(this.encoder.encode(String(s)+'\n'));return this;}
    encode(s){
      this.parts=[];const lines=String(s).split('\n');
      this.bytes([0x1b,0x40]);this.bytes([0x1b,0x61,0x01]);this.bytes([0x1b,0x45,0x01]);this.bytes([0x1d,0x21,0x11]);this.text(lines.shift()||'TOKO');
      this.bytes([0x1d,0x21,0x00]);this.bytes([0x1b,0x45,0x00]);this.text(lines.shift()||'');this.text(lines.shift()||'');
      this.bytes([0x1b,0x61,0x00]);this.text(lines.join('\n'));
      const invoiceLine=String(s).split('\n').find(line=>line.startsWith('No:'));
      const qrData=invoiceLine?invoiceLine.slice(3).trim():'';
      if(qrData){
        const data=this.encoder.encode(qrData);const length=data.length+3;
        this.bytes([0x1b,0x61,0x01]);
        this.bytes([0x1d,0x28,0x6b,4,0,0x31,0x41,0x32,0]);
        this.bytes([0x1d,0x28,0x6b,3,0,0x31,0x43,6]);
        this.bytes([0x1d,0x28,0x6b,3,0,0x31,0x45,0x31]);
        this.bytes([0x1d,0x28,0x6b,length&255,(length>>8)&255,0x31,0x50,0x30]);
        this.parts.push(data);
        this.bytes([0x1d,0x28,0x6b,3,0,0x31,0x51,0x30]);
        this.bytes([0x1b,0x61,0x00]);
      }
      this.bytes([0x1b,0x64,0x03]);this.bytes([0x1d,0x56,0x42,0x00]);
      const len=this.parts.reduce((n,p)=>n+p.length,0);const out=new Uint8Array(len);let pos=0;this.parts.forEach(p=>{out.set(p,pos);pos+=p.length;});return out;
    }
  }
  function shareReceipt() {
    if(!state.lastReceipt)return;const r=state.lastReceipt;const customer=(state.customers||[]).find(c=>c.customer_id===r.transaction.customer_id);const phone=String(customer?.phone||'').replace(/\D/g,'');const msg=receiptText(r);
    const full=phone?(phone.startsWith('0')?'62'+phone.slice(1):phone):'';
    const url=`https://wa.me/${full}?text=${encodeURIComponent(msg)}`;window.open(url,'_blank','noopener');
  }

  async function openCamera() {
    if(!('BarcodeDetector' in window)){openModal('Scan barcode manual',`<form id="camera-manual-form" class="space-y-3"><p class="text-sm text-slate-500">Browser ini belum menyediakan BarcodeDetector. Masukkan barcode secara manual atau gunakan scanner USB/Bluetooth HID.</p><input name="barcode" class="field mono" autofocus placeholder="Scan / ketik barcode" required><button class="btn btn-primary w-full">Cari produk</button></form>`);return;}
    openModal('Scan barcode',`<div class="rounded-xl bg-black overflow-hidden aspect-video"><video id="camera-video" class="w-full h-full object-cover" autoplay playsinline muted></video></div><p id="camera-status" class="text-xs text-slate-500 mt-3">Arahkan kamera ke barcode produk.</p><form id="camera-manual-form" class="flex gap-2 mt-3"><input name="barcode" class="field mono" placeholder="Atau masukkan barcode"><button class="btn">Cari</button></form>`);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});state.cameraStream=stream;
      const video=$('#camera-video');if(!video)return;video.srcObject=stream;await video.play();
      const detector=new BarcodeDetector({formats:['ean_13','ean_8','upc_a','code_128','qr_code']});
      const scan=async()=>{if(!state.cameraStream||!$('#camera-video'))return;try{const hits=await detector.detect(video);if(hits.length){const code=hits[0].rawValue;stopCamera();const p=state.catalog.products.find(x=>String(x.barcode)===String(code)||String(x.sku)===String(code));if(state.scanTarget==='product-barcode'){const back=state.scanReturnModal;state.scanTarget=null;state.scanReturnModal=null;state.modal=back;render();const field=$('input[name=barcode]');if(field){field.value=code;field.focus();}showToast(`Barcode terbaca: ${code}`);return;}if(p){state.modal=null;addToCart(p.product_id);showToast(`Barcode ditemukan: ${p.name}`);}else{state.modal=null;state.search=code;render();showToast(`Barcode ${code} belum terdaftar.`,'warning');}return;}}catch(_){}state.cameraFrame=setTimeout(scan,240);};scan();
    }catch(err){const status=$('#camera-status');if(status)status.textContent='Kamera tidak dapat dibuka: '+err.message;showToast('Izin kamera ditolak atau kamera tidak tersedia.','error');}
  }
  function stopCamera(){if(state.cameraFrame){clearTimeout(state.cameraFrame);state.cameraFrame=null;}if(state.cameraStream){state.cameraStream.getTracks().forEach(t=>t.stop());state.cameraStream=null;}}
  function handleHidScanner(e) {
    const active=document.activeElement;
    if(active&&active.matches('input,textarea,select,[contenteditable="true"]')&&active.id!=='product-search')return;
    const now=performance.now();if(!state.hidBuffer)state.hidBuffer='';
    if(e.key==='Enter'){
      const code=state.hidBuffer;state.hidBuffer='';
      if(code.length>=4&&now-state.hidLast<90){const p=state.catalog.products.find(x=>String(x.barcode)===code||String(x.sku)===code);if(p){addToCart(p.product_id);beep();}else{state.search=code;render();showToast(`Barcode ${code} tidak ditemukan.`,'warning');}}
      return;
    }
    if(e.key.length===1){if(now-state.hidLast>90)state.hidBuffer='';state.hidBuffer+=e.key;state.hidLast=now;}
  }
  function beep(){try{const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;const ctx=new Ctx();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.connect(gain);gain.connect(ctx.destination);osc.frequency.value=880;gain.gain.value=.04;osc.start();osc.stop(ctx.currentTime+.07);osc.onended=()=>ctx.close();}catch(_){}}

  // Global app lifecycle, optimistic cache, and offline queue synchronization.
  async function init() {
    state.customers=readJson('pos_customers',[]);state.history=readJson('pos_history',[]);
    document.addEventListener('keydown',handleHidScanner);
    window.addEventListener('online',()=>{state.online=true;render();syncOutbox();});
    window.addEventListener('offline',()=>{state.online=false;render();showToast('Koneksi terputus. Checkout akan masuk antrean offline.','warning');});
    window.addEventListener('focus',()=>{if(navigator.onLine)syncOutbox();});
    if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(err=>console.warn('Service worker:',err));}
    if(state.token&&state.user){
      if(!navigator.onLine){state.page='pos';render();showToast('Mode offline aktif. Transaksi akan masuk antrean.','warning');return;}
      try{await loadBootstrap();await loadCustomers();render();syncOutbox();}
      catch(err){localStorage.removeItem(STORAGE.token);localStorage.removeItem(STORAGE.user);state.token='';state.user=null;render();showToast(err.message,'warning');}
    }else render();
  }

  // Add the final small action routes after the primary dispatcher has been defined.
  const originalHandleClick = handleClick;
  handleClick = function(e) {
    const actionEl=e.target.closest('[data-action]');
    if(actionEl?.dataset.action==='print-last-receipt'){printLastReceipt();return;}
    if(actionEl?.dataset.action==='share-last-receipt'){shareReceipt();return;}
    return originalHandleClick(e);
  };
  const originalHandleSubmit = handleSubmit;
  handleSubmit = async function(e) {
    if(e.target.id==='camera-manual-form'){
      e.preventDefault();const code=new FormData(e.target).get('barcode');if(state.scanTarget==='product-barcode'){const back=state.scanReturnModal;state.scanTarget=null;state.scanReturnModal=null;state.modal=back;render();const field=$('input[name=barcode]');if(field)field.value=code;return;}const p=state.catalog.products.find(x=>String(x.barcode)===String(code)||String(x.sku)===String(code));if(p){state.modal=null;addToCart(p.product_id);}else showToast('Barcode belum terdaftar.','warning');return;
    }
    return originalHandleSubmit(e);
  };

  init();
})();
