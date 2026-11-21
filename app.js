// ==========================================
// POS SUPERAPP FRONTEND LOGIC
// ==========================================

const API_URL = '/api/pos'; // Routed via vercel.json to GAS
let state = {
  cart: [],
  catalog: [],
  btDevice: null,
  btCharacteristic: null,
  token: localStorage.getItem('pos_token') || null,
  offlineQueue: JSON.parse(localStorage.getItem('offline_queue') || '[]')
};

// ==========================================
// 1. API HANDLER (CORS BYPASS)
// ==========================================
async function apiCall(action, payload = {}) {
  const body = { action, token: state.token, ...payload };
  
  try {
    // PENTING: Gunakan text/plain untuk menghindari CORS Preflight OPTIONS di GAS
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.message);
    return data.data;
  } catch (err) {
    console.error('API Error:', err);
    showToast(err.message, 'error');
    // Queue for offline sync if network fails
    if (err.message.includes('Failed to fetch')) {
      state.offlineQueue.push(body);
      localStorage.setItem('offline_queue', JSON.stringify(state.offlineQueue));
      updateSyncStatus(false);
    }
    throw err;
  }
}

// ==========================================
// 2. CATALOG & POS UI
// ==========================================
async function loadCatalog() {
  try {
    const data = await apiCall('getCatalog');
    state.catalog = data.products;
    renderProducts();
  } catch (e) { /* Fallback to IndexedDB/Local Cache if needed */ }
}

function renderProducts() {
  const grid = document.getElementById('product-grid');
  grid.innerHTML = state.catalog.map(p => `
    <div class="bento-card p-3 flex flex-col gap-2 cursor-pointer" onclick="addToCart('${p[0]}', '${p[3]}', ${p[6]}, ${p[5]})">
      <div class="aspect-square bg-[#F8F9FA] rounded-lg border border-slate-200 flex items-center justify-center text-3xl">☕</div>
      <div class="flex-1">
        <h3 class="font-bold text-sm line-clamp-2">${p[3]}</h3>
        <p class="text-xs text-slate-500 font-mono">${p[1]}</p>
      </div>
      <div class="flex justify-between items-center mt-auto">
        <span class="font-mono font-bold text-sm">Rp ${p[6].toLocaleString()}</span>
        <span class="px-1.5 py-0.5 bg-[#DDD6FE] border border-[#1E293B] rounded text-[10px] font-bold">Stok: ${p[8]}</span>
      </div>
    </div>
  `).join('');
}

function addToCart(id, name, price, cost) {
  const existing = state.cart.find(i => i.id === id);
  if (existing) {
    existing.qty++;
  } else {
    state.cart.push({ id, name, price, cost, qty: 1 });
  }
  renderCart();
}

function renderCart() {
  const total = state.cart.reduce((sum, i) => sum + (i.price * i.qty), 0);
  document.getElementById('cart-total').innerText = `Rp ${total.toLocaleString()}`;
  
  // Mobile Cart Bar
  const mobileBar = document.getElementById('mobile-cart-bar');
  if (state.cart.length > 0) {
    mobileBar.classList.remove('hidden');
    document.getElementById('mobile-cart-count').innerText = `${state.cart.length} Item`;
    document.getElementById('mobile-cart-total').innerText = `Rp ${total.toLocaleString()}`;
  } else {
    mobileBar.classList.add('hidden');
  }
}

// ==========================================
// 3. WEB BLUETOOTH ESC/POS (20-BYTE CHUNKING)
// ==========================================
async function connectBluetooth() {
  try {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported');
    
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['000018f0-0000-1000-8000-00805f9b34fb'] }] // Standard Serial Port
    });
    
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb');
    const characteristics = await service.getCharacteristics();
    
    state.btDevice = device;
    state.btCharacteristic = characteristics[0]; // Usually the write characteristic
    showToast('Printer Terhubung!', 'success');
  } catch (err) {
    showToast('Gagal koneksi: ' + err.message, 'error');
  }
}

async function printReceipt(trxData) {
  if (!state.btCharacteristic) {
    showToast('Printer belum terhubung', 'error');
    return;
  }

  // Simple ESC/POS Encoder
  const encoder = new TextEncoder();
  let buffer = new Uint8Array();
  
  const append = (str) => {
    const bytes = encoder.encode(str);
    const newBuffer = new Uint8Array(buffer.length + bytes.length);
    newBuffer.set(buffer);
    newBuffer.set(bytes, buffer.length);
    buffer = newBuffer;
  };

  // ESC @ (Init), ESC a 1 (Center)
  append('\x1B@');
  append('\x1Ba1');
  append('*** KOPI SENJA ***\n');
  append('Jl. Sudirman No. 123\n');
  append('--------------------------------\n');
  append('\x1Ba0'); // Left align
  append(`No: ${trxData.invoice}\n`);
  append(`Tgl: ${trxData.date}\n`);
  append('--------------------------------\n');
  
  trxData.items.forEach(item => {
    append(`${item.name}\n`);
    append(`  ${item.qty}x @ Rp${item.price}\n`);
    append(`             Rp${item.subtotal}\n`);
  });
  
  append('--------------------------------\n');
  append(`TOTAL        Rp${trxData.total}\n`);
  append(`BAYAR        Rp${trxData.paid}\n`);
  append(`KEMBALI      Rp${trxData.change}\n`);
  append('\n');
  append('\x1Ba1');
  append('Terima Kasih!\n');
  append('\n\n\n');
  append('\x1D\x56\x00'); // Cut paper

  // PENTING: Chunking 20-byte untuk mencegah MTU Buffer Overflow
  const chunkSize = 20;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.slice(i, i + chunkSize);
    await state.btCharacteristic.writeValue(chunk);
    await new Promise(r => setTimeout(r, 20)); // 20ms delay antar chunk
  }
}

// ==========================================
// 4. HARDWARE BARCODE SCANNER (HID LISTENER)
// ==========================================
let scanBuffer = '';
let scanTimeout = null;

document.addEventListener('keydown', (e) => {
  // Listen for rapid keystrokes (Barcode HID)
  if (e.key === 'Enter' && scanBuffer.length > 3) {
    e.preventDefault();
    handleBarcodeScan(scanBuffer);
    scanBuffer = '';
  } else if (e.key.length === 1) {
    scanBuffer += e.key;
    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => { scanBuffer = ''; }, 50); // Reset if > 50ms
  }
});

function handleBarcodeScan(barcode) {
  const product = state.catalog.find(p => p[1] === barcode);
  if (product) {
    addToCart(product[0], product[3], product[6], product[5]);
    playBeep();
  } else {
    showToast(`Barcode ${barcode} tidak ditemukan`, 'error');
  }
}

function playBeep() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(800, ctx.currentTime);
  osc.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.1);
}

// ==========================================
// 5. UTILITIES & INIT
// ==========================================
function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `fixed top-16 right-4 px-4 py-2 bento-card z-50 font-bold text-sm ${type === 'error' ? 'bg-[#FECACA]' : 'bg-[#A7F3D0]'}`;
  toast.innerText = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function updateSyncStatus(isOnline) {
  const el = document.getElementById('sync-status');
  el.innerText = isOnline ? 'Online' : 'Offline';
  el.className = `px-2 py-1 text-xs font-bold border border-[#1E293B] rounded-full ${isOnline ? 'bg-[#A7F3D0]' : 'bg-[#FECACA]'}`;
}

// Event Listeners
document.getElementById('btn-bt').addEventListener('click', connectBluetooth);
document.getElementById('btn-checkout').addEventListener('click', async () => {
  if (state.cart.length === 0) return;
  
  const payload = {
    cart: state.cart,
    customer: { id: 'CUST-001', name: 'Umum' },
    payment: {
      subtotal: state.cart.reduce((s, i) => s + (i.price * i.qty), 0),
      discount: 0, tax: 0,
      grand_total: state.cart.reduce((s, i) => s + (i.price * i.qty), 0),
      method: 'Tunai', amount_paid: 100000, change_due: 0
    },
    cashierId: 'USR-001',
    cashierName: 'Admin'
  };

  try {
    const res = await apiCall('processCheckout', payload);
    showToast('Transaksi Berhasil!', 'success');
    state.cart = [];
    renderCart();
    // Trigger print (Mock data for demo)
    printReceipt({ invoice: 'INV-123', date: new Date().toLocaleString(), items: payload.cart, total: payload.payment.grand_total, paid: 100000, change: 0 });
  } catch (e) {}
});

// Init App
window.addEventListener('load', () => {
  loadCatalog();
  updateSyncStatus(navigator.onLine);
  window.addEventListener('online', () => updateSyncStatus(true));
  window.addEventListener('offline', () => updateSyncStatus(false));
});