# POS SuperApp — GAS + Google Sheets + Vercel

Aplikasi POS mobile-first berbasis Vanilla JavaScript, Google Apps Script Web App, dan Google Sheets. Frontend bersifat static/PWA sehingga dapat di-host pada Vercel tanpa proses build.

## Isi project

- `Code.gs` — REST-like JSON router, autentikasi, RBAC, database Google Sheets, checkout, stok, pelanggan, piutang, shift, laporan, dan pengeluaran.
- `index.html` — shell aplikasi, Tailwind CDN, gaya visual Bento/Neobrutalist-lite.
- `app.js` — UI SPA, login SHA-256, katalog, checkout, split payment, scanner, printer, PWA/offline queue, laporan, dan Gemini BYOK.
- `vercel.json` — pengaturan static hosting, headers, dan rewrite SPA.
- `manifest.json`, `sw.js`, `icon.svg` — instalasi PWA dan cache app shell.

## A. Menyiapkan backend Google Apps Script

1. Buat sebuah Google Spreadsheet kosong, misalnya `POS SuperApp Database`.
2. Dari spreadsheet, buka **Extensions → Apps Script**.
3. Salin isi `Code.gs` ke file `Code.gs` pada editor Apps Script, lalu simpan.
4. Pada editor Apps Script, pilih fungsi `setupDatabase`, lalu klik **Run** dan setujui izin. Fungsi ini membuat tab dan header database secara otomatis. Jika project Apps Script dibuat standalone tanpa spreadsheet aktif, fungsi akan membuat spreadsheet baru dan menyimpan ID-nya pada Script Properties.
5. Buka **Project Settings → Script Properties**, tambahkan properti berikut untuk membuat akun owner awal:

   | Property | Contoh nilai |
   |---|---|
   | `INITIAL_ADMIN_USERNAME` | `owner` |
   | `INITIAL_ADMIN_PASSWORD` | password kuat minimal 10 karakter |
   | `INITIAL_ADMIN_PIN` | PIN 4–6 digit |
   | `INITIAL_ADMIN_NAME` | `Administrator Toko` |

6. Kembali ke editor, jalankan fungsi `bootstrapAdmin` satu kali. Fungsi membuat akun owner dengan hash SHA-256 dan menghapus empat properti kredensial sementara tadi. Jangan jalankan ulang setelah tab Users terisi.
7. Opsional: pada **Project Settings**, atur timezone project ke `Asia/Jakarta` agar tanggal laporan dan invoice sesuai zona waktu toko.
8. Pilih **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (atau opsi akses organisasi yang sesuai kebijakan Anda)
9. Salin URL Web App yang berakhiran `/exec`. URL ini dimasukkan pada halaman login frontend.

> Endpoint Web App dapat diakses secara publik bila memilih Anyone, tetapi endpoint data selain health/login memerlukan session token yang ditandatangani backend. Jangan membagikan spreadsheet database kepada pengguna kasir. Akses spreadsheet tetap dikelola melalui akun Google pemilik deployment.

## B. Deploy frontend ke Vercel

1. Buat repository Git baru dan letakkan seluruh file frontend dalam direktori root project (`index.html`, `app.js`, `vercel.json`, `manifest.json`, `sw.js`, `icon.svg`). `Code.gs` dapat disimpan di repo untuk versioning, tetapi tidak dijalankan oleh Vercel.
2. Import repository ke Vercel.
3. Pilih Framework Preset **Other** dan biarkan Build Command serta Output Directory kosong/default untuk static hosting.
4. Deploy. Buka domain Vercel yang diberikan.
5. Pada layar login, tempel URL GAS `/exec`, lalu masuk menggunakan username dan password/PIN owner yang dibuat pada langkah A.
6. Setelah login, buka **Pengaturan** untuk melengkapi identitas toko, pajak default, dan lebar printer.

URL GAS disimpan di localStorage browser yang digunakan. Untuk browser/perangkat kasir lain, masukkan URL yang sama pada halaman login.

## C. Menyiapkan master data

1. Buka menu **Produk → Kategori** untuk menambahkan kategori.
2. Buka **Produk → Tambah produk** untuk memasukkan SKU, barcode, harga modal, harga jual, stok, satuan, dan pajak produk.
3. Buka **Pengguna** untuk membuat akun kasir/manager/admin. Password minimal 10 karakter dan PIN 4–6 digit.
4. Tambahkan pelanggan pada menu **Pelanggan** bila diperlukan.
5. Kasir perlu membuka shift sebelum checkout. Modal awal, penerimaan tunai, kas masuk/keluar, dan selisih tutup shift dicatat pada tab terkait.

## D. Fitur yang tersedia

- Autentikasi username/password atau username/PIN dengan SHA-256 Web Crypto; sesi HMAC bertanda tangan dengan masa aktif 6 jam dan pembatasan percobaan login.
- RBAC untuk owner, admin, manager, dan cashier. Pengecekan akses dilakukan di backend, bukan hanya menyembunyikan menu frontend.
- Katalog, kategori, pelanggan, checkout multi-item, diskon transaksi, pajak, metode Tunai/QRIS/Transfer/Kartu, split payment, dan Kasbon.
- Stok otomatis berkurang saat checkout; mutasi stok dicatat dan checkout/stock adjustment menggunakan ScriptLock.
- Piutang dan pencatatan pembayaran angsuran.
- Pesanan tertahan, pengeluaran, shift kasir, kas masuk/keluar, dan laporan rentang tanggal.
- Filter laporan pelanggan, kasir, kategori, dan metode pembayaran; ekspor CSV.
- Scanner USB/Bluetooth HID melalui keyboard wedge dan scan kamera melalui `BarcodeDetector` pada browser yang mendukung.
- Web Bluetooth ESC/POS dengan pengiriman buffer per 20 byte dan jeda; Browser Print sebagai fallback.
- Gemini BYOK: `gemini-3.5-flash-lite` dan `gemini-3.1-flash-lite`. API key disimpan pada localStorage browser, bukan di source code maupun Sheets.
- PWA app shell dan antrean checkout lokal yang dikirim ke GAS saat koneksi kembali.

## E. Catatan penting sebelum produksi

- **Google Sheets cocok untuk skala kecil/menengah dan beban transaksi rendah–menengah.** Untuk multi-outlet dengan transaksi padat, kebutuhan audit formal, atau SLA tinggi, pertimbangkan database transaksional (mis. Cloud SQL/Firestore) dan backend khusus.
- Arsitektur ini mengikuti spesifikasi SHA-256 client-side. Hash yang dikirim login bertindak sebagai kredensial autentikasi, sehingga wajib menggunakan HTTPS, password kuat, perangkat kasir yang terkontrol, dan pembatasan akses. PIN 4–6 digit hanya untuk pergantian kasir cepat; jangan jadikan PIN sebagai satu-satunya kontrol untuk akun administrator.
- Web Bluetooth memerlukan browser/perangkat yang mendukung Web Bluetooth dan printer BLE GATT yang mengekspos karakteristik tulis yang kompatibel. Banyak printer Bluetooth Classic/SPP atau printer vendor tertentu tidak dapat diakses oleh Web Bluetooth standar. Uji model printer sebelum operasional; Browser Print menjadi fallback.
- `BarcodeDetector` belum tersedia pada semua browser. Scanner USB/Bluetooth HID tetap dapat digunakan sebagai input keyboard.
- Offline queue menyimpan transaksi lokal dan melakukan sinkronisasi ulang berdasarkan `client_ref`. Sinkronisasi dapat ditolak backend apabila stok server telah berubah/tidak mencukupi; periksa antrean dan rekonsiliasi data dalam kondisi tersebut. Jangan mengandalkan offline mode sebagai sistem multi-kasir tanpa koneksi.
- Gemini BYOK mengirim ringkasan data toko ke Google Gemini API sesuai pertanyaan pengguna. Pengguna bertanggung jawab atas pengelolaan API key dan kebijakan data yang dikirim.
- Sebelum penggunaan nyata, lakukan uji transaksi, kembalian, split payment, pajak, Kasbon, retur/koreksi transaksi (belum disediakan dalam versi ini), stock opname, tutup shift, dan pemulihan backup spreadsheet.

## F. Pemecahan masalah

- **Respons bukan JSON / login gagal:** pastikan URL benar-benar URL deployment `/exec`, deployment memakai versi terbaru, dan akses Web App sesuai kebutuhan.
- **Perubahan Code.gs tidak muncul:** lakukan **Deploy → Manage deployments → Edit → New version → Deploy**.
- **Katalog kosong:** buat kategori dan produk melalui menu Produk.
- **Printer tidak ditemukan:** pastikan printer mendukung BLE GATT, aktifkan Bluetooth, izinkan akses perangkat, lalu uji Browser Print. Periksa UUID service/characteristic printer bila berbeda dari UUID generik yang dicoba aplikasi.
- **Transaksi offline belum tersinkron:** hubungkan internet, buka ulang aplikasi, pastikan sesi login masih berlaku, dan periksa pesan sinkronisasi.
