/**
 * POS SuperApp — Google Apps Script JSON API
 * Database: Google Sheets. Deploy as Web App (Execute as: Me; Access: Anyone).
 * Frontend sends POST text/plain to avoid a browser CORS preflight.
 */

// ID Google Spreadsheet database (diisi manual sesuai spreadsheet yang digunakan).
const DB_ID = '1dPOeQ_Pgavzwj_Tz9IAQEJ22jTliEIVKeRAwUZgg3_o';

const APP = {
  NAME: 'POS SuperApp',
  VERSION: '1.0.1',
  SESSION_TTL: 21600,
  CACHE_TTL: 120,
  ROLES: ['owner', 'admin', 'manager', 'cashier'],
  SCHEMA: {
    Users: ['user_id','username','full_name','password_hash','pin_hash','role','outlet_id','status','last_login'],
    Categories: ['category_id','name','icon','color_hex','sort_order','is_active'],
    Products: ['product_id','barcode','sku','name','category_id','buy_price','sell_price','member_price','stock','min_stock','unit','tax_rate','is_active','updated_at'],
    Customers: ['customer_id','name','phone','email','tier','points','total_spent','visit_count','notes','created_at'],
    Transactions: ['trx_id','invoice_no','timestamp','date_str','customer_id','customer_name','cashier_id','cashier_name','subtotal','discount_amount','tax_amount','grand_total','payment_method','amount_paid','change_due','status','notes'],
    Transaction_Items: ['item_id','trx_id','product_id','barcode','product_name','qty','unit_price','cost_price','discount','subtotal','profit'],
    Stock_Movements: ['move_id','timestamp','product_id','type','qty_change','stock_before','stock_after','ref_id','user_id','note'],
    Expenses: ['expense_id','date_str','category','description','amount','payment_method','user_id'],
    Shifts: ['shift_id','cashier_id','opened_at','closed_at','opening_cash','expected_cash','actual_cash','variance','status'],
    Settings: ['key','value'],
    // Additional ledgers required by the architecture's split-payment / offline value-adds.
    Payment_Entries: ['payment_id','trx_id','shift_id','customer_id','method','amount','timestamp','user_id','note'],
    Customer_Debts: ['debt_id','trx_id','customer_id','original_amount','outstanding_amount','status','created_at','updated_at'],
    Debt_Payments: ['payment_id','debt_id','customer_id','amount','method','timestamp','user_id','note'],
    Cash_Movements: ['move_id','shift_id','type','amount','description','timestamp','user_id'],
    Held_Carts: ['cart_id','label','customer_id','customer_name','cart_json','created_at','updated_at','user_id']
  }
};

const DEFAULT_SETTINGS = {
  store_name: 'Toko Anda', store_address: '', store_phone: '', receipt_footer: 'Terima kasih telah berbelanja!',
  tax_percent: '0', currency: 'IDR', currency_symbol: 'Rp', allow_negative_stock: 'false',
  printer_width: '58', active_gemini_model: 'gemini-3.5-flash-lite', outlet_id: 'OUTLET-001'
};

function doGet(e) {
  const action = e && e.parameter && e.parameter.action ? String(e.parameter.action) : 'health';
  if (action === 'health') return json_({ ok: true, app: APP.NAME, version: APP.VERSION, timestamp: new Date().toISOString() });
  return json_({ ok: false, error: 'Gunakan POST untuk API aplikasi.' });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const req = JSON.parse(raw);
    const action = String(req.action || '');
    const data = req.data || {};
    let result;
    if (action === 'auth.login') result = login_(data);
    else if (action === 'auth.pinLogin') result = pinLogin_(data);
    else if (action === 'health') result = { ok: true, app: APP.NAME, version: APP.VERSION, timestamp: new Date().toISOString() };
    else {
      const user = authenticate_(req.token);
      if (action === 'auth.me') result = { user: publicUser_(user) };
      else if (action === 'auth.logout') { CacheService.getScriptCache().remove(sessionCacheKey_(req.token)); result = { logged_out: true }; }
      else result = route_(action, data, user);
    }
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: safeError_(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function safeError_(err) { return err && err.message ? String(err.message) : 'Terjadi kesalahan pada server.'; }
function uuid_() { return Utilities.getUuid(); }
function nowIso_() { return new Date().toISOString(); }
function dateStr_(d) { return Utilities.formatDate(d || new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd'); }
function num_(v, fallback) { const n = Number(v); return isFinite(n) ? n : (fallback || 0); }
function text_(v, max) { const s = String(v == null ? '' : v).trim(); return max ? s.substring(0, max) : s; }
function bool_(v) { return v === true || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function hash_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join(''); }

function getDb_() {
  if (!DB_ID || DB_ID === 'MASUKKAN_ID_SPREADSHEET') {
    throw new Error('DB_ID belum diisi. Masukkan ID Google Spreadsheet pada konstanta DB_ID di Code.gs.');
  }
  try {
    return SpreadsheetApp.openById(DB_ID);
  } catch (err) {
    throw new Error('Database tidak dapat dibuka. Periksa DB_ID dan pastikan akun deployment memiliki akses ke spreadsheet. Detail: ' + safeError_(err));
  }
}

function setupDatabase() {
  // Seluruh tab dan header dibuat langsung pada spreadsheet dengan ID di konstanta DB_ID.
  const ss = getDb_();
  Object.keys(APP.SCHEMA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = APP.SCHEMA[name];
    const current = sh.getRange(1, 1, 1, Math.max(headers.length, sh.getLastColumn() || 1)).getValues()[0];
    const same = headers.every((h, i) => current[i] === h);
    if (!same) {
      if (sh.getLastRow() > 1 && current.some(v => v !== '')) throw new Error('Header tab ' + name + ' tidak sesuai. Periksa sebelum menjalankan setupDatabase() kembali.');
      sh.clear(); sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1E293B').setFontColor('#FFFFFF');
    sh.autoResizeColumns(1, headers.length);
  });
  const settings = ss.getSheetByName('Settings');
  const existing = readObjects_(settings);
  const keys = new Set(existing.map(r => String(r.key)));
  Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!keys.has(k)) settings.appendRow([k, DEFAULT_SETTINGS[k]]); });
  SpreadsheetApp.flush();
  Logger.log('Database siap: ' + ss.getUrl());
  return { spreadsheetId: ss.getId(), url: ss.getUrl(), tabs: Object.keys(APP.SCHEMA) };
}

/**
 * One-time admin bootstrap. Set Script Properties:
 * INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_PASSWORD, INITIAL_ADMIN_PIN, INITIAL_ADMIN_NAME.
 * The temporary password/PIN properties are removed after successful creation.
 */
function bootstrapAdmin() {
  const ss = getDb_();
  const sh = ss.getSheetByName('Users');
  if (sh.getLastRow() > 1) throw new Error('Tab Users sudah berisi data. Bootstrap dibatalkan.');
  const p = PropertiesService.getScriptProperties();
  const username = text_(p.getProperty('INITIAL_ADMIN_USERNAME'), 60).toLowerCase();
  const password = p.getProperty('INITIAL_ADMIN_PASSWORD') || '';
  const pin = p.getProperty('INITIAL_ADMIN_PIN') || '';
  const name = text_(p.getProperty('INITIAL_ADMIN_NAME') || 'Administrator', 100);
  if (!username || password.length < 10 || !/^\d{4,6}$/.test(pin)) throw new Error('Isi INITIAL_ADMIN_USERNAME, password minimal 10 karakter, dan PIN 4–6 digit pada Script Properties.');
  sh.appendRow([uuid_(), username, name, hash_(password), hash_(pin), 'owner', getSetting_('outlet_id') || 'OUTLET-001', 'active', nowIso_()]);
  ['INITIAL_ADMIN_USERNAME','INITIAL_ADMIN_PASSWORD','INITIAL_ADMIN_PIN','INITIAL_ADMIN_NAME'].forEach(k => p.deleteProperty(k));
  return 'Admin awal berhasil dibuat. Kredensial sementara di Script Properties telah dihapus.';
}

function getSetting_(key) {
  const sh = getDb_().getSheetByName('Settings');
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) if (String(values[i][0]) === key) return values[i][1];
  return DEFAULT_SETTINGS[key] || '';
}
function setSetting_(key, value) {
  const sh = getDb_().getSheetByName('Settings');
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) if (String(values[i][0]) === key) { sh.getRange(i + 1, 2).setValue(String(value)); return; }
  sh.appendRow([key, String(value)]);
}
function readObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(r => r.some(v => v !== '' && v !== null)).map(row => {
    const o = {}; headers.forEach((h, i) => o[h] = row[i]); return o;
  });
}
function appendObject_(sheetName, obj) {
  const sh = getDb_().getSheetByName(sheetName);
  const headers = APP.SCHEMA[sheetName];
  sh.appendRow(headers.map(h => obj[h] === undefined ? '' : obj[h]));
}
function updateById_(sheetName, idField, id, patch) {
  const sh = getDb_().getSheetByName(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const idIndex = headers.indexOf(idField);
  if (idIndex < 0) throw new Error('Kolom ID tidak ditemukan.');
  for (let r = 1; r < values.length; r++) if (String(values[r][idIndex]) === String(id)) {
    Object.keys(patch).forEach(k => { const c = headers.indexOf(k); if (c >= 0) sh.getRange(r + 1, c + 1).setValue(patch[k]); });
    return true;
  }
  return false;
}
function findBy_(sheetName, field, value) { return readObjects_(getDb_().getSheetByName(sheetName)).find(r => String(r[field]) === String(value)) || null; }
function invalidateCache_() { const c = CacheService.getScriptCache(); ['catalog','dashboard'].forEach(k => c.remove(k)); }
function cachedJson_(key, fn, ttl) {
  const c = CacheService.getScriptCache(); const hit = c.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (_) {} }
  const value = fn(); c.put(key, JSON.stringify(value), ttl || APP.CACHE_TTL); return value;
}

function publicUser_(u) { return { user_id: u.user_id, username: u.username, full_name: u.full_name, role: u.role, outlet_id: u.outlet_id }; }
function sessionCacheKey_(token) { return 'sess_' + hash_(token || ''); }
function issueSession_(user) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('POS_AUTH_SECRET');
  if (!secret) { secret = uuid_() + uuid_() + uuid_(); props.setProperty('POS_AUTH_SECRET', secret); }
  const payload = { uid: user.user_id, exp: Date.now() + APP.SESSION_TTL * 1000, nonce: uuid_() };
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret));
  const token = body + '.' + sig;
  CacheService.getScriptCache().put(sessionCacheKey_(token), JSON.stringify({ uid: user.user_id, exp: payload.exp }), APP.SESSION_TTL);
  return token;
}
function authenticate_(token) {
  if (!token) throw new Error('Sesi tidak ditemukan. Silakan login kembali.');
  const parts = String(token).split('.'); if (parts.length !== 2) throw new Error('Token sesi tidak valid.');
  const secret = PropertiesService.getScriptProperties().getProperty('POS_AUTH_SECRET');
  const expected = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], secret || ''));
  if (expected !== parts[1]) throw new Error('Token sesi tidak valid.');
  let payload; try { payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); } catch (_) { throw new Error('Token sesi rusak.'); }
  if (!payload.exp || Date.now() > Number(payload.exp)) throw new Error('Sesi telah berakhir. Silakan login kembali.');
  const cached = CacheService.getScriptCache().get(sessionCacheKey_(token));
  if (!cached) throw new Error('Sesi tidak aktif. Silakan login kembali.');
  const user = findBy_('Users', 'user_id', payload.uid);
  if (!user || String(user.status).toLowerCase() !== 'active') throw new Error('Akun tidak aktif.');
  return user;
}
function authThrottleKey_(username) { return 'authfail_' + hash_(String(username || '').toLowerCase()); }
function checkAuthThrottle_(username) { const count = Number(CacheService.getScriptCache().get(authThrottleKey_(username)) || 0); if (count >= 8) throw new Error('Terlalu banyak percobaan login. Coba kembali sekitar 15 menit lagi.'); }
function registerAuthFailure_(username) { const c = CacheService.getScriptCache(); const key = authThrottleKey_(username); const count = Number(c.get(key) || 0) + 1; c.put(key, String(count), 900); }
function clearAuthFailures_(username) { CacheService.getScriptCache().remove(authThrottleKey_(username)); }
function login_(data) {
  const username = text_(data.username, 60).toLowerCase(); const passwordHash = text_(data.passwordHash, 128).toLowerCase();
  if (!username || !/^[a-f0-9]{64}$/.test(passwordHash)) throw new Error('Username atau password tidak valid.');
  checkAuthThrottle_(username);
  const user = readObjects_(getDb_().getSheetByName('Users')).find(u => String(u.username).toLowerCase() === username);
  if (!user || String(user.status).toLowerCase() !== 'active' || String(user.password_hash).toLowerCase() !== passwordHash) { registerAuthFailure_(username); throw new Error('Username atau password salah.'); }
  clearAuthFailures_(username);
  updateById_('Users', 'user_id', user.user_id, { last_login: nowIso_() });
  return { token: issueSession_(user), user: publicUser_(user), expires_in: APP.SESSION_TTL };
}
function pinLogin_(data) {
  const username = text_(data.username, 60).toLowerCase(); const pinHash = text_(data.pinHash, 128).toLowerCase();
  if (!username || !/^[a-f0-9]{64}$/.test(pinHash)) throw new Error('Username atau PIN tidak valid.');
  checkAuthThrottle_(username);
  const user = readObjects_(getDb_().getSheetByName('Users')).find(u => String(u.username).toLowerCase() === username);
  if (!user || String(user.status).toLowerCase() !== 'active' || String(user.pin_hash).toLowerCase() !== pinHash) { registerAuthFailure_(username); throw new Error('Username atau PIN salah.'); }
  clearAuthFailures_(username);
  updateById_('Users', 'user_id', user.user_id, { last_login: nowIso_() });
  return { token: issueSession_(user), user: publicUser_(user), expires_in: APP.SESSION_TTL };
}
function requireRole_(user, allowed) {
  if (allowed.indexOf(String(user.role).toLowerCase()) < 0) throw new Error('Akses ditolak untuk peran ' + user.role + '.');
}
function route_(action, d, u) {
  switch (action) {
    case 'bootstrap': return bootstrapData_(u);
    case 'dashboard.summary': requireRole_(u, ['owner','admin','manager']); return dashboardSummary_(d);
    case 'catalog.list': return getCatalog_();
    case 'products.save': requireRole_(u, ['owner','admin','manager']); return saveProduct_(d, u);
    case 'products.delete': requireRole_(u, ['owner','admin']); return deactivate_('Products','product_id',d.id);
    case 'categories.save': requireRole_(u, ['owner','admin']); return saveCategory_(d);
    case 'customers.list': return listCustomers_(d);
    case 'customers.save': requireRole_(u, ['owner','admin','manager','cashier']); return saveCustomer_(d);
    case 'reports.sales': requireRole_(u, ['owner','admin','manager']); return salesReport_(d);
    case 'expenses.list': requireRole_(u, ['owner','admin','manager']); return listExpenses_(d);
    case 'expenses.save': requireRole_(u, ['owner','admin','manager']); return saveExpense_(d, u);
    case 'inventory.adjust': requireRole_(u, ['owner','admin','manager']); return adjustStock_(d, u);
    case 'transactions.list': return listTransactions_(d, u);
    case 'transactions.get': return getTransaction_(d, u);
    case 'checkout': return checkout_(d, u);
    case 'shifts.current': return currentShift_(u);
    case 'shifts.open': return openShift_(d, u);
    case 'shifts.close': return closeShift_(d, u);
    case 'cash.move': requireRole_(u, ['owner','admin','manager','cashier']); return cashMove_(d, u);
    case 'held.list': return listHeld_(u);
    case 'held.save': return saveHeld_(d, u);
    case 'held.delete': return deleteHeld_(d, u);
    case 'debts.list': requireRole_(u, ['owner','admin','manager','cashier']); return listDebts_(d);
    case 'debt.pay': requireRole_(u, ['owner','admin','manager','cashier']); return payDebt_(d, u);
    case 'users.list': requireRole_(u, ['owner','admin']); return readObjects_(getDb_().getSheetByName('Users')).map(publicUser_);
    case 'users.save': requireRole_(u, ['owner','admin']); return saveUser_(d);
    case 'settings.get': requireRole_(u, ['owner','admin','manager']); return getSettings_();
    case 'settings.save': requireRole_(u, ['owner','admin']); return saveSettings_(d);
    default: throw new Error('Aksi API tidak dikenal: ' + action);
  }
}

function bootstrapData_(user) {
  const result = { user: publicUser_(user), settings: getSettings_(), catalog: getCatalog_(), shift: currentShift_(user) };
  if (['owner','admin','manager'].includes(String(user.role).toLowerCase())) result.dashboard = dashboardSummary_({});
  return result;
}
function getSettings_() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  readObjects_(getDb_().getSheetByName('Settings')).forEach(r => out[String(r.key)] = String(r.value));
  return out;
}
function saveSettings_(data) {
  Object.keys(data || {}).forEach(k => { if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) setSetting_(k, text_(data[k], 500)); });
  invalidateCache_(); return getSettings_();
}
function getCatalog_() {
  return cachedJson_('catalog', () => ({
    categories: readObjects_(getDb_().getSheetByName('Categories')).filter(r => bool_(r.is_active)),
    products: readObjects_(getDb_().getSheetByName('Products')).filter(r => bool_(r.is_active))
  }), APP.CACHE_TTL);
}
function dashboardSummary_(filters) {
  return cachedJson_('dashboard', () => {
    const today = dateStr_();
    const tx = readObjects_(getDb_().getSheetByName('Transactions')).filter(t => t.date_str === today && t.status === 'paid');
    const products = readObjects_(getDb_().getSheetByName('Products')).filter(p => bool_(p.is_active));
    const expenses = readObjects_(getDb_().getSheetByName('Expenses')).filter(e => e.date_str === today).reduce((s,e) => s + num_(e.amount), 0);
    const lowStock = products.filter(p => num_(p.stock) <= num_(p.min_stock)).slice(0, 8).map(p => ({ product_id:p.product_id, name:p.name, stock:num_(p.stock), min_stock:num_(p.min_stock), unit:p.unit }));
    const items = readObjects_(getDb_().getSheetByName('Transaction_Items'));
    const map = {};
    tx.forEach(t => items.filter(i => i.trx_id === t.trx_id).forEach(i => { map[i.product_name] = (map[i.product_name] || 0) + num_(i.qty); }));
    const topProducts = Object.keys(map).map(name => ({ name, qty: map[name] })).sort((a,b) => b.qty-a.qty).slice(0,5);
    const revenue = tx.reduce((s,t) => s + num_(t.grand_total), 0);
    const profit = tx.reduce((s,t) => s + items.filter(i => i.trx_id === t.trx_id).reduce((a,i) => a + num_(i.profit), 0), 0) - expenses;
    return { date:today, revenue, net_profit:profit, transactions:tx.length, aov:tx.length ? revenue/tx.length : 0, products:products.length, low_stock:lowStock, top_products:topProducts, expenses };
  }, 45);
}
function saveProduct_(d,u) {
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const name = text_(d.name, 120); if (!name) throw new Error('Nama produk wajib diisi.');
    const id = text_(d.product_id, 80) || uuid_();
    const item = { product_id:id, barcode:text_(d.barcode, 80), sku:text_(d.sku, 80), name, category_id:text_(d.category_id, 80), buy_price:Math.max(0,num_(d.buy_price)), sell_price:Math.max(0,num_(d.sell_price)), member_price:Math.max(0,num_(d.member_price)), stock:num_(d.stock), min_stock:Math.max(0,num_(d.min_stock)), unit:text_(d.unit || 'pcs', 20), tax_rate:Math.max(0,num_(d.tax_rate, num_(getSetting_('tax_percent')))), is_active:true, updated_at:nowIso_() };
    if (item.stock < 0 && !bool_(getSetting_('allow_negative_stock'))) throw new Error('Stok awal tidak boleh negatif.');
    const old = findBy_('Products','product_id',id);
    if (old) {
      updateById_('Products','product_id',id,item);
      const delta = num_(item.stock) - num_(old.stock);
      if (delta !== 0) appendObject_('Stock_Movements',{move_id:uuid_(),timestamp:nowIso_(),product_id:id,type:'product_edit_adjustment',qty_change:delta,stock_before:num_(old.stock),stock_after:num_(item.stock),ref_id:id,user_id:u.user_id,note:'Penyesuaian stok dari form produk'});
    } else {
      appendObject_('Products',item);
      if (num_(item.stock) !== 0) appendObject_('Stock_Movements',{move_id:uuid_(),timestamp:nowIso_(),product_id:id,type:'initial_stock',qty_change:num_(item.stock),stock_before:0,stock_after:num_(item.stock),ref_id:id,user_id:u.user_id,note:'Stok awal produk'});
    }
    invalidateCache_(); return item;
  } finally { lock.releaseLock(); }
}
function deactivate_(sheet, idField, id) {
  if (!id || !updateById_(sheet,idField,id,{is_active:false})) throw new Error('Data tidak ditemukan.');
  invalidateCache_(); return { id, is_active:false };
}
function saveCategory_(d) {
  const name = text_(d.name, 80); if (!name) throw new Error('Nama kategori wajib diisi.');
  const id = text_(d.category_id,80) || uuid_();
  const item = { category_id:id, name, icon:text_(d.icon || '▦',8), color_hex:text_(d.color_hex || '#DDD6FE',10), sort_order:num_(d.sort_order), is_active:true };
  if (findBy_('Categories','category_id',id)) updateById_('Categories','category_id',id,item); else appendObject_('Categories',item);
  invalidateCache_(); return item;
}
function listCustomers_(d) {
  const q = text_(d.q,100).toLowerCase();
  return readObjects_(getDb_().getSheetByName('Customers')).filter(c => !q || [c.name,c.phone,c.email].join(' ').toLowerCase().includes(q)).slice(0,500);
}
function saveCustomer_(d) {
  const name = text_(d.name,120); if (!name) throw new Error('Nama pelanggan wajib diisi.');
  const id = text_(d.customer_id,80) || uuid_(); const old = findBy_('Customers','customer_id',id);
  const item = { customer_id:id, name, phone:text_(d.phone,40), email:text_(d.email,120), tier:text_(d.tier || 'regular',30), points:old ? num_(old.points) : 0, total_spent:old ? num_(old.total_spent) : 0, visit_count:old ? num_(old.visit_count) : 0, notes:text_(d.notes,500), created_at:old ? old.created_at : nowIso_() };
  if (old) updateById_('Customers','customer_id',id,item); else appendObject_('Customers',item);
  return item;
}
function saveUser_(d) {
  const username = text_(d.username,60).toLowerCase(); const fullName = text_(d.full_name,100);
  if (!/^[a-z0-9._-]{3,60}$/.test(username) || !fullName) throw new Error('Username minimal 3 karakter (huruf/angka/._-) dan nama wajib diisi.');
  const id = text_(d.user_id,80) || uuid_(); const old = findBy_('Users','user_id',id);
  if (!old && (!/^[a-f0-9]{64}$/i.test(d.passwordHash || '') || !/^[a-f0-9]{64}$/i.test(d.pinHash || ''))) throw new Error('Password dan PIN baru wajib diisi.');
  const duplicate = readObjects_(getDb_().getSheetByName('Users')).find(x => String(x.username).toLowerCase() === username && x.user_id !== id);
  if (duplicate) throw new Error('Username sudah digunakan.');
  const role = APP.ROLES.includes(text_(d.role,20).toLowerCase()) ? text_(d.role,20).toLowerCase() : 'cashier';
  const item = { user_id:id, username, full_name:fullName, password_hash:d.passwordHash || (old && old.password_hash) || '', pin_hash:d.pinHash || (old && old.pin_hash) || '', role, outlet_id:text_(d.outlet_id || getSetting_('outlet_id'),60), status:text_(d.status || 'active',20), last_login:old ? old.last_login : '' };
  if (old) updateById_('Users','user_id',id,item); else appendObject_('Users',item);
  return publicUser_(item);
}
function listExpenses_(d) {
  const from = text_(d.from,10); const to = text_(d.to,10);
  return readObjects_(getDb_().getSheetByName('Expenses')).filter(e => (!from || e.date_str >= from) && (!to || e.date_str <= to)).sort((a,b) => String(b.date_str).localeCompare(String(a.date_str))).slice(0,1000);
}
function saveExpense_(d,u) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const amount = num_(d.amount); if (amount <= 0) throw new Error('Nominal pengeluaran harus lebih dari nol.');
    const obj = { expense_id:uuid_(), date_str:text_(d.date_str || dateStr_(),10), category:text_(d.category || 'Operasional',60), description:text_(d.description,200), amount, payment_method:text_(d.payment_method || 'Tunai',30), user_id:u.user_id };
    appendObject_('Expenses',obj);
    const shift = currentShift_(u);
    if (shift && obj.payment_method.toLowerCase() === 'tunai') appendObject_('Cash_Movements',{move_id:uuid_(),shift_id:shift.shift_id,type:'out',amount,description:'Pengeluaran: '+obj.description,timestamp:nowIso_(),user_id:u.user_id});
    invalidateCache_(); return obj;
  } finally { lock.releaseLock(); }
}
function adjustStock_(d,u) {
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const p = findBy_('Products','product_id',d.product_id); if (!p) throw new Error('Produk tidak ditemukan.');
    const counted = d.counted_stock !== undefined ? num_(d.counted_stock) : null;
    const delta = counted === null ? num_(d.qty_change) : counted - num_(p.stock);
    if (!delta) return { product_id:p.product_id, stock:num_(p.stock), qty_change:0 };
    const after = num_(p.stock) + delta;
    if (after < 0) throw new Error('Stok tidak boleh menjadi negatif.');
    updateById_('Products','product_id',p.product_id,{stock:after,updated_at:nowIso_()});
    appendObject_('Stock_Movements',{move_id:uuid_(),timestamp:nowIso_(),product_id:p.product_id,type:delta > 0 ? 'adjustment_in' : 'adjustment_out',qty_change:delta,stock_before:num_(p.stock),stock_after:after,ref_id:text_(d.note,100),user_id:u.user_id,note:text_(d.note || 'Penyesuaian stok',200)});
    invalidateCache_(); return { product_id:p.product_id, stock:after, qty_change:delta };
  } finally { lock.releaseLock(); }
}

function checkout_(d,u) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const clientRef = text_(d.client_ref,100);
    if (clientRef) {
      const existing = readObjects_(getDb_().getSheetByName('Transactions')).find(t => String(t.notes || '').indexOf('"client_ref":"' + clientRef + '"') >= 0);
      if (existing) return { transaction:existing, duplicate:true };
    }
    const lines = Array.isArray(d.items) ? d.items : []; if (!lines.length) throw new Error('Keranjang masih kosong.');
    const products = readObjects_(getDb_().getSheetByName('Products'));
    const computed = []; let subtotal = 0; let grossSubtotal = 0; let lineDiscountTotal = 0; let taxRaw = 0;
    lines.forEach(line => {
      const p = products.find(x => x.product_id === line.product_id && bool_(x.is_active));
      if (!p) throw new Error('Salah satu produk tidak ditemukan atau sudah nonaktif.');
      const qty = num_(line.qty); if (qty <= 0) throw new Error('Jumlah produk harus lebih dari nol.');
      if (!bool_(getSetting_('allow_negative_stock')) && num_(p.stock) < qty) throw new Error('Stok ' + p.name + ' tidak mencukupi. Tersedia: ' + p.stock + '.');
      const raw = qty * num_(p.sell_price); const discount = Math.min(raw, Math.max(0,num_(line.discount)));
      const lineSub = raw - discount; const taxRate = (p.tax_rate === '' || p.tax_rate === null || p.tax_rate === undefined) ? num_(getSetting_('tax_percent')) : num_(p.tax_rate); const lineTax = lineSub * Math.max(0,taxRate) / 100;
      grossSubtotal += raw; lineDiscountTotal += discount; subtotal += lineSub; taxRaw += lineTax;
      computed.push({ p, qty, discount, lineSub, lineTax, cost:num_(p.buy_price), line });
    });
    const trxDiscount = Math.min(subtotal, Math.max(0,num_(d.discount_amount)));
    const discountRatio = subtotal > 0 ? (subtotal - trxDiscount) / subtotal : 1;
    const taxAmount = taxRaw * discountRatio;
    const grandTotal = Math.max(0, Math.round(subtotal - trxDiscount + taxAmount));
    const customer = d.customer_id ? findBy_('Customers','customer_id',d.customer_id) : null;
    const payments = Array.isArray(d.payments) ? d.payments : [{ method:d.payment_method || 'Tunai', amount:grandTotal }];
    const receivedEntries = payments.filter(p => String(p.method).toLowerCase() !== 'kasbon' && num_(p.amount) > 0);
    const received = receivedEntries.reduce((s,p) => s + num_(p.amount), 0);
    const dueFromPayment = payments.filter(p => String(p.method).toLowerCase() === 'kasbon').reduce((s,p) => s + num_(p.amount), 0);
    const outstanding = Math.max(0, grandTotal - received);
    if (received > grandTotal + 0.01) {
      // Overpayment is only accepted for a cash-only payment; change is recorded separately.
      if (receivedEntries.length !== 1 || String(receivedEntries[0].method).toLowerCase() !== 'tunai') throw new Error('Total pembayaran melebihi tagihan.');
    }
    if ((outstanding > 0 || dueFromPayment > 0) && !customer) throw new Error('Pilih pelanggan untuk transaksi Kasbon/Tempo.');
    if (dueFromPayment > 0 && Math.abs(dueFromPayment - outstanding) > 1) throw new Error('Nominal Kasbon harus sama dengan sisa tagihan.');
    if (outstanding > 0 && !dueFromPayment) throw new Error('Sisa tagihan belum dialokasikan sebagai Kasbon.');
    const now = nowIso_(); const date = dateStr_(new Date()); const trxId = uuid_();
    const invoice = 'INV-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyMMdd-HHmmss') + '-' + Math.floor(100 + Math.random()*900);
    const shift = currentShift_(u);
    if (String(u.role).toLowerCase() === 'cashier' && !shift) throw new Error('Buka shift terlebih dahulu sebelum checkout.');
    const shiftId = shift ? shift.shift_id : '';
    const change = Math.max(0, received - grandTotal);
    const paymentMethods = receivedEntries.map(p => p.method);
    if (outstanding > 0) paymentMethods.push('Kasbon');
    const paymentSummary = paymentMethods.filter((v,i,a) => a.indexOf(v) === i).join(' + ') || 'Tunai';
    const notes = JSON.stringify({ client_ref:clientRef, shift_id:shiftId, payment_breakdown:payments, cashier_note:text_(d.notes,300) });
    appendObject_('Transactions',{ trx_id:trxId, invoice_no:invoice, timestamp:now, date_str:date, customer_id:customer ? customer.customer_id : '', customer_name:customer ? customer.name : 'Pelanggan Umum', cashier_id:u.user_id, cashier_name:u.full_name, subtotal:grossSubtotal, discount_amount:trxDiscount + lineDiscountTotal, tax_amount:taxAmount, grand_total:grandTotal, payment_method:paymentSummary, amount_paid:Math.min(received,grandTotal), change_due:change, status:'paid', notes });
    computed.forEach(x => {
      const lineTax = x.lineTax * discountRatio; const lineTotal = x.lineSub * discountRatio + lineTax;
      appendObject_('Transaction_Items',{ item_id:uuid_(), trx_id:trxId, product_id:x.p.product_id, barcode:x.p.barcode, product_name:x.p.name, qty:x.qty, unit_price:num_(x.p.sell_price), cost_price:x.cost, discount:x.discount, subtotal:lineTotal, profit:(x.lineSub * discountRatio) - x.qty*x.cost });
      const after = num_(x.p.stock) - x.qty;
      updateById_('Products','product_id',x.p.product_id,{stock:after,updated_at:now});
      appendObject_('Stock_Movements',{move_id:uuid_(),timestamp:now,product_id:x.p.product_id,type:'sale',qty_change:-x.qty,stock_before:num_(x.p.stock),stock_after:after,ref_id:trxId,user_id:u.user_id,note:'Penjualan '+invoice});
    });
    receivedEntries.forEach(p => appendObject_('Payment_Entries',{payment_id:uuid_(),trx_id:trxId,shift_id:shiftId,customer_id:customer ? customer.customer_id : '',method:text_(p.method,30),amount:num_(p.amount),timestamp:now,user_id:u.user_id,note:'gross_tendered'}));
    if (outstanding > 0) appendObject_('Customer_Debts',{debt_id:uuid_(),trx_id:trxId,customer_id:customer.customer_id,original_amount:outstanding,outstanding_amount:outstanding,status:'open',created_at:now,updated_at:now});
    if (customer) updateById_('Customers','customer_id',customer.customer_id,{total_spent:num_(customer.total_spent)+grandTotal,visit_count:num_(customer.visit_count)+1,points:num_(customer.points)+Math.floor(grandTotal/10000)});
    invalidateCache_();
    const trx = findBy_('Transactions','trx_id',trxId);
    return { transaction:trx, items:computed.map(x=>({product_name:x.p.name,qty:x.qty,unit_price:num_(x.p.sell_price),subtotal:x.lineSub})), payments, outstanding, shift_id:shiftId };
  } finally { lock.releaseLock(); }
}
function listTransactions_(d,u) {
  let rows = readObjects_(getDb_().getSheetByName('Transactions'));
  if (String(u.role).toLowerCase() === 'cashier') rows = rows.filter(t => t.cashier_id === u.user_id);
  if (d.from) rows = rows.filter(t => t.date_str >= d.from); if (d.to) rows = rows.filter(t => t.date_str <= d.to);
  return rows.sort((a,b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0,500);
}
function getTransaction_(d,u) {
  const trx = findBy_('Transactions','trx_id',d.trx_id); if (!trx) throw new Error('Transaksi tidak ditemukan.');
  if (String(u.role).toLowerCase() === 'cashier' && trx.cashier_id !== u.user_id) throw new Error('Anda hanya dapat melihat transaksi sendiri.');
  return { transaction:trx, items:readObjects_(getDb_().getSheetByName('Transaction_Items')).filter(i=>i.trx_id===trx.trx_id), payments:readObjects_(getDb_().getSheetByName('Payment_Entries')).filter(p=>p.trx_id===trx.trx_id) };
}
function salesReport_(d) {
  const from = text_(d.from || dateStr_(),10); const to = text_(d.to || dateStr_(),10);
  const allTx = readObjects_(getDb_().getSheetByName('Transactions')).filter(t => t.date_str >= from && t.date_str <= to && t.status === 'paid');
  let tx = allTx.slice();
  if (d.customer_id) tx = tx.filter(t => t.customer_id === d.customer_id);
  if (d.cashier_id) tx = tx.filter(t => t.cashier_id === d.cashier_id);
  if (d.payment_method) tx = tx.filter(t => String(t.payment_method).toLowerCase().includes(String(d.payment_method).toLowerCase()));
  const products = readObjects_(getDb_().getSheetByName('Products'));
  const categories = readObjects_(getDb_().getSheetByName('Categories'));
  const allItems = readObjects_(getDb_().getSheetByName('Transaction_Items'));
  const categoryProductIds = d.category_id ? new Set(products.filter(p => p.category_id === d.category_id).map(p => p.product_id)) : null;
  const reportIds = new Set(tx.map(t=>t.trx_id));
  let items = allItems.filter(i => reportIds.has(i.trx_id));
  if (categoryProductIds) items = items.filter(i => categoryProductIds.has(i.product_id));
  if (categoryProductIds) {
    const matchingTrx = new Set(items.map(i=>i.trx_id));
    tx = tx.filter(t=>matchingTrx.has(t.trx_id));
  }
  const itemRevenue = items.reduce((s,i)=>s+num_(i.subtotal),0);
  const revenue = categoryProductIds ? itemRevenue : tx.reduce((s,t)=>s+num_(t.grand_total),0);
  const allRevenue = allTx.reduce((s,t)=>s+num_(t.grand_total),0);
  const expenseTotal = readObjects_(getDb_().getSheetByName('Expenses')).filter(e=>e.date_str>=from && e.date_str<=to).reduce((s,e)=>s+num_(e.amount),0);
  // Allocate operating expenses proportionally when the result is a filtered slice of sales.
  const expenses = allRevenue > 0 ? expenseTotal * Math.min(1, revenue / allRevenue) : 0;
  const cogs = items.reduce((s,i)=>s+num_(i.qty)*num_(i.cost_price),0);
  const itemProfit = items.reduce((s,i)=>s+num_(i.profit),0);
  const byProduct = {}; const byCategory = {};
  items.forEach(i=>{ byProduct[i.product_name]=(byProduct[i.product_name]||0)+num_(i.qty); const p=products.find(x=>x.product_id===i.product_id); const c=categories.find(x=>x.category_id===(p?p.category_id:'')); const cat=c?c.name:'Lainnya'; byCategory[cat]=(byCategory[cat]||0)+num_(i.subtotal); });
  return { from,to, transactions:tx, categories_master:categories.map(c=>({category_id:c.category_id,name:c.name})), summary:{ revenue, cogs, gross_profit:itemProfit, expenses, net_profit:itemProfit-expenses, transaction_count:tx.length, aov:tx.length?revenue/tx.length:0 }, top_products:Object.keys(byProduct).map(k=>({name:k,qty:byProduct[k]})).sort((a,b)=>b.qty-a.qty).slice(0,10), categories:Object.keys(byCategory).map(k=>({name:k,value:byCategory[k]})).sort((a,b)=>b.value-a.value), customers:readObjects_(getDb_().getSheetByName('Customers')).map(c=>({customer_id:c.customer_id,name:c.name})), cashiers:readObjects_(getDb_().getSheetByName('Users')).map(x=>({user_id:x.user_id,full_name:x.full_name})) };
}
function currentShift_(u) { return readObjects_(getDb_().getSheetByName('Shifts')).filter(s=>s.cashier_id===u.user_id && s.status==='open').sort((a,b)=>String(b.opened_at).localeCompare(String(a.opened_at)))[0] || null; }
function openShift_(d,u) {
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try { if (currentShift_(u)) throw new Error('Shift Anda masih terbuka.'); const s={shift_id:uuid_(),cashier_id:u.user_id,opened_at:nowIso_(),closed_at:'',opening_cash:Math.max(0,num_(d.opening_cash)),expected_cash:0,actual_cash:'',variance:'',status:'open'}; appendObject_('Shifts',s); return s; }
  finally { lock.releaseLock(); }
}
function shiftExpectedCash_(shift) {
  const opening=num_(shift.opening_cash);
  const cashEntries=readObjects_(getDb_().getSheetByName('Payment_Entries')).filter(p=>p.shift_id===shift.shift_id && String(p.method).toLowerCase()==='tunai');
  const payments=cashEntries.reduce((s,p)=>s+num_(p.amount),0);
  const cashMovements=readObjects_(getDb_().getSheetByName('Cash_Movements')).filter(m=>m.shift_id===shift.shift_id).reduce((s,m)=>s+(m.type==='in'?num_(m.amount):-num_(m.amount)),0);
  const transactions=readObjects_(getDb_().getSheetByName('Transactions')).filter(t=>{try{return JSON.parse(t.notes||'{}').shift_id===shift.shift_id;}catch(_){return false;}});
  // New payment rows store gross cash received, so subtract their change.
  // Historical rows stored the amount applied to the bill (already net of change).
  const grossTenderTrxIds=new Set(cashEntries.filter(p=>p.note==='gross_tendered').map(p=>p.trx_id));
  const change=transactions.filter(t=>grossTenderTrxIds.has(t.trx_id)).reduce((s,t)=>s+num_(t.change_due),0);
  return opening+payments-change+cashMovements;
}
function closeShift_(d,u) {
  const lock=LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const s=currentShift_(u); if (!s) throw new Error('Tidak ada shift aktif.');
    const expected=shiftExpectedCash_(s); const actual=Math.max(0,num_(d.actual_cash));
    updateById_('Shifts','shift_id',s.shift_id,{closed_at:nowIso_(),expected_cash:expected,actual_cash:actual,variance:actual-expected,status:'closed'});
    return {shift_id:s.shift_id,expected_cash:expected,actual_cash:actual,variance:actual-expected,status:'closed'};
  } finally { lock.releaseLock(); }
}
function cashMove_(d,u) {
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const s=currentShift_(u); if (!s) throw new Error('Buka shift terlebih dahulu.');
    const amount=num_(d.amount); if (amount<=0) throw new Error('Nominal harus lebih dari nol.');
    const type=d.type==='in'?'in':'out';
    const item={move_id:uuid_(),shift_id:s.shift_id,type,amount,description:text_(d.description || (type==='in'?'Kas masuk':'Kas keluar'),200),timestamp:nowIso_(),user_id:u.user_id};
    appendObject_('Cash_Movements',item); return item;
  } finally { lock.releaseLock(); }
}
function listHeld_(u) { return readObjects_(getDb_().getSheetByName('Held_Carts')).filter(c=>c.user_id===u.user_id).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))); }
function saveHeld_(d,u) {
  const id=text_(d.cart_id,80)||uuid_(); const obj={cart_id:id,label:text_(d.label||'Pesanan tertahan',80),customer_id:text_(d.customer_id,80),customer_name:text_(d.customer_name,100),cart_json:JSON.stringify(d.items||[]),created_at:d.created_at||nowIso_(),updated_at:nowIso_(),user_id:u.user_id};
  const old=findBy_('Held_Carts','cart_id',id); if(old){if(old.user_id!==u.user_id) throw new Error('Tidak diizinkan.'); updateById_('Held_Carts','cart_id',id,obj);} else appendObject_('Held_Carts',obj); return obj;
}
function deleteHeld_(d,u) { const old=findBy_('Held_Carts','cart_id',d.cart_id); if(!old||old.user_id!==u.user_id) throw new Error('Keranjang tidak ditemukan.'); const sh=getDb_().getSheetByName('Held_Carts'); const rows=sh.getDataRange().getValues(); for(let i=1;i<rows.length;i++)if(rows[i][0]===d.cart_id){sh.deleteRow(i+1);break;} return {deleted:true}; }
function listDebts_(d) {
  const customers = readObjects_(getDb_().getSheetByName('Customers'));
  const tx = readObjects_(getDb_().getSheetByName('Transactions'));
  return readObjects_(getDb_().getSheetByName('Customer_Debts')).filter(x => !d.status || x.status === d.status).map(x => {
    const c = customers.find(y => y.customer_id === x.customer_id);
    const t = tx.find(y => y.trx_id === x.trx_id);
    return Object.assign({}, x, { customer_name: c ? c.name : '-', customer_phone: c ? c.phone : '', invoice_no: t ? t.invoice_no : '' });
  }).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
}
function payDebt_(d,u) {
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try { const debt=findBy_('Customer_Debts','debt_id',d.debt_id); if(!debt||debt.status!=='open') throw new Error('Piutang tidak ditemukan atau sudah lunas.'); const amount=num_(d.amount); if(amount<=0||amount>num_(debt.outstanding_amount)) throw new Error('Nominal pembayaran tidak valid.');
    const method = text_(d.method||'Tunai',30);
    appendObject_('Debt_Payments',{payment_id:uuid_(),debt_id:debt.debt_id,customer_id:debt.customer_id,amount,method,timestamp:nowIso_(),user_id:u.user_id,note:text_(d.note,200)});
    const shift = currentShift_(u);
    if (shift && method.toLowerCase() === 'tunai') appendObject_('Cash_Movements',{move_id:uuid_(),shift_id:shift.shift_id,type:'in',amount,description:'Pembayaran piutang',timestamp:nowIso_(),user_id:u.user_id});
    const after=num_(debt.outstanding_amount)-amount; updateById_('Customer_Debts','debt_id',debt.debt_id,{outstanding_amount:after,status:after<=0?'paid':'open',updated_at:nowIso_()}); return {debt_id:debt.debt_id,outstanding_amount:after,status:after<=0?'paid':'open'};
  } finally { lock.releaseLock(); }
}
