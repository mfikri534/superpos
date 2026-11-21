# POS SuperApp — Laporan Audit & Perbaikan v1.2.0

## Ringkasan masalah dari screenshot

1. Konten dashboard dan halaman lain berada di belakang dock navigasi bawah pada smartphone.
2. Kartu/list produk pada layar kecil terlalu rapat dan kurang jelas; tampilan desktop juga membutuhkan hierarki katalog yang lebih teratur.
3. Struk menampilkan nominal dibayar sebesar tagihan, bukan uang tunai yang benar-benar diterima; baris diskon/pajak nol tidak dibutuhkan.
4. Dashboard, laporan, dan riwayat tidak menemukan transaksi yang tanggalnya telah dikonversi Google Sheets menjadi nilai `Date`.

## Perubahan versi 1.2.0

### UI/UX responsif

- Konten utama sekarang menggunakan selector berprioritas lebih tinggi agar padding bawah tidak ditimpa utility Tailwind.
- Ruang bawah mobile ditambah untuk dock navigasi dan safe area; tinggi konten mengikuti viewport dinamis.
- Dock bawah diberi tinggi dan target sentuh yang lebih nyaman.
- Halaman Produk menggunakan kartu katalog responsif: informasi nama, SKU/barcode, kategori, harga modal/jual, stok, batas minimum, dan tombol edit memiliki pemisahan visual yang jelas.
- Layout kartu produk menyesuaikan layar kecil, tablet, dan desktop.
- Navigasi Produk diselaraskan dengan RBAC Owner/Admin; endpoint backend juga menolak penyimpanan produk oleh Manager agar frontend dan backend konsisten.

### Transaksi dan struk

- `Transactions.amount_paid` menyimpan jumlah uang yang diterima sebelum kembalian, bukan dibatasi pada nilai tagihan.
- Struk Browser Print dan ESC/POS menggunakan total payment entries (selain Kasbon) untuk menampilkan uang diterima.
- Kompatibilitas data lama dipertahankan: jika payment entries tidak tersedia, helper memakai catatan semantik pembayaran atau `amount_paid + change_due`.
- Baris Diskon dan Pajak hanya ditampilkan jika nilainya lebih besar dari nol.
- Pemeriksaan `client_ref` memakai parse JSON dan pencocokan exact equality, bukan substring, agar retry tidak membuat transaksi ganda.
- Kembalian dikurangi tepat satu kali pada perhitungan kas shift; uang diterima tetap tercatat penuh dalam Payment_Entries.

### Konsistensi tanggal dan laporan

- Zona waktu aplikasi diseragamkan ke `Asia/Jakarta` pada GAS dan frontend.
- `dateKey_()` menormalisasi objek Date Google Sheets, ISO date/timestamp, `yyyy-MM-dd`, dan teks tanggal lokal `dd/MM/yyyy`.
- `readObjects_()` menormalkan `date_str` serta kolom timestamp sebelum filtering/sorting.
- Dashboard, laporan penjualan, riwayat transaksi, dan daftar pengeluaran memakai normalisasi tanggal yang sama.
- Cache dashboard/katalog diberi namespace versi baru; tombol Perbarui Data mengirim `force:true` untuk mengosongkan cache dashboard sebelum membaca ulang.
- Status transaksi paid menerima variasi status umum (paid/completed/lunas/success/settled) tanpa memasukkan status batal.

### PWA/deployment

- Service Worker menggunakan cache `pos-superapp-v5`.
- HTML dan JavaScript memakai strategi network-first, dengan cache sebagai fallback saat offline, agar perbaikan dari Vercel tidak tertahan oleh JavaScript lama.
- Registrasi frontend memicu pemeriksaan pembaruan Service Worker.
- Header Vercel digabung dalam satu rule dan aset menggunakan `max-age=0, must-revalidate`.

## Hasil pengujian yang dilakukan

Pengujian dilakukan dengan mock Google Sheets dan layanan Apps Script di Node.js; ini bukan koneksi ke spreadsheet produksi pengguna.

- `node --check` pada `app.js`, `Code.gs` (diperiksa sebagai JavaScript), dan `sw.js`.
- Parse JSON pada `vercel.json` dan `manifest.json`.
- Pemeriksaan 28 endpoint API frontend terhadap router backend (termasuk auth logout yang ditangani langsung oleh `doPost`).
- Pemeriksaan ID form terhadap handler submit (form kamera manual ditangani handler khusus).
- Simulasi transaksi dengan tanggal Google Sheets bertipe `Date`: Dashboard, Laporan, dan Riwayat berhasil menemukan transaksi.
- Simulasi nilai tanggal Indonesia `21/11/2026` berhasil dinormalisasi.
- Simulasi transaksi Rp3.000 dengan uang tunai diterima Rp5.000: amount paid Rp5.000, change Rp2.000, stok turun satu kali.
- Simulasi retry dengan `client_ref` sama tidak membuat transaksi kedua dan stok tidak dikurangi ulang.
- Simulasi kas shift: modal awal Rp10.000 + tunai diterima Rp5.000 − kembalian Rp2.000 = kas diharapkan Rp13.000.
- Uji helper struk: menampilkan `Dibayar: 5.000`, `Kembali: 2.000`, dan tidak menampilkan Diskon/Pajak ketika nol.
- Validasi file lokal yang dirujuk `index.html` dan integritas arsip ZIP.

## Batas verifikasi

Audit source dan pengujian logika terisolasi telah dilakukan. Saya belum dapat menguji langsung Spreadsheet/Apps Script deployment milik pengguna, browser pada ponsel fisik, printer BLE tertentu, kamera perangkat, koneksi Gemini real, atau akun Vercel pengguna. Keberhasilan fungsi tersebut juga bergantung pada izin, zona waktu spreadsheet, browser, model printer, dan konfigurasi deployment. Karena itu, hasil ini bukan jaminan mutlak bahwa semua kondisi produksi bebas error.

## File produksi

- `Code.gs`
- `index.html`
- `app.js`
- `vercel.json`
- `manifest.json`
- `sw.js`
- `icon.svg`
- `README.md`


## Audit UI/UX CardView versi 1.2.1

### Temuan akar masalah
- Implementasi lama menggunakan kelas `.table-row`, nama yang juga merupakan utility bawaan Tailwind untuk `display: table-row`. Konflik cascade membuat layout grid card tidak konsisten dan dapat menyebabkan kolom informasi/tombol tampak bertumpuk pada ponsel.

### Perbaikan
- Menghapus seluruh penggunaan kelas `.table-row`, `.desk-col`, `.mobile-sub`, dan `.row-amount` dari halaman aplikasi.
- Menggunakan kelas komponen unik `record-list`, `record-card`, `record-card-head`, `record-card-metrics`, dan `record-card-footer`.
- Membuat satu kolom pada smartphone, dua kolom pada layar lebar, ruang teks yang membungkus, metrik dengan label, status badge, dan aksi dengan target sentuh yang cukup.
- Mengubah daftar produk, pelanggan, piutang, inventori, pengeluaran, riwayat transaksi, pengguna, serta transaksi laporan ke CardView.
- Memperbarui pencarian/filter tanpa mengganti nama selector `.product-row`, `.customer-row`, `.inventory-row`, dan `.history-row`.
- Memperbarui Service Worker ke cache v5 dengan network-first untuk HTML, JavaScript, style, dan manifest.

### Pemeriksaan
- Sintaks JavaScript: diperiksa dengan `node --check`.
- Konflik class `.table-row` / aturan layout lama: tidak ada penggunaan komponen tersebut pada markup aplikasi.
- Selector pencarian dan aksi: dipertahankan di markup kartu.
- HTML dan konfigurasi Vercel: validasi statis dilakukan.
- Render visual lintas perangkat dan koneksi database produksi: belum dapat dikonfirmasi melalui akun/perangkat pengguna; lakukan uji ponsel dan desktop setelah deployment.
