# POS SuperApp — Catatan Audit & Perbaikan v1.0.1

## Perbaikan pada versi ini

1. **Konten bawah pada smartphone** — tinggi minimum mengikuti `100dvh`/`100svh`; konten utama diberi padding bawah untuk dock navigasi dan safe-area; dock, tombol POS sticky, dan toast ditempatkan agar tidak menutupi konten.
2. **Modal tanggal/kategori/pilihan** — modal tidak lagi ditutup oleh klik apa pun yang berasal dari dalam sheet. Modal hanya ditutup jika target klik adalah backdrop itu sendiri, tombol tutup, atau tombol Escape.
3. **Input Gemini API Key** — field form tetap aktif saat diklik/diketik; perubahan key hanya disimpan saat form dikirim. Key tetap berada di localStorage browser dan tidak dikirim ke spreadsheet/backend GAS.
4. **Shift & kas** — rumus kas diharapkan membedakan payment entry lama (nominal bersih) dan payment entry baru (nominal tunai sebelum kembalian). Transaksi baru mengurangi nilai kembalian tepat satu kali.
5. **Konsistensi mutasi** — penyimpanan produk/stok dan kas masuk/keluar menggunakan ScriptLock sehingga tidak bertabrakan dengan checkout atau penutupan shift.
6. **PWA cache** — versi cache dinaikkan menjadi `pos-superapp-v2` untuk memaksa aset baru diunduh setelah deployment frontend.
7. **Database** — konstanta `DB_ID` manual tetap dipertahankan sesuai Spreadsheet ID yang diberikan.

## Pemeriksaan yang berhasil

- `node --check` pada `app.js`, `Code.gs` (sebagai JavaScript), dan `sw.js`.
- Parse JSON pada `vercel.json` dan `manifest.json`.
- Parse script inline pada `index.html`.
- Pemeriksaan referensi aset lokal yang digunakan `index.html`.
- Pemeriksaan ID form terhadap handler submit.
- Pemeriksaan setiap pemanggilan API frontend terhadap endpoint backend.
- Pemeriksaan source untuk memastikan pola lama `data-stop-click` sudah tidak digunakan.
- Uji fungsi perhitungan kas dengan data simulasi: transaksi baru dengan kembalian, transaksi historis bersih, dan gabungan keduanya. Semua hasil cocok dengan nilai kas yang diharapkan.

## Batas verifikasi

Pemeriksaan ini merupakan audit source code dan pengujian logika terisolasi. Belum dilakukan transaksi langsung pada Google Spreadsheet milik pengguna, deployment pada project Vercel pengguna, uji perangkat Android/iOS fisik, kamera, Bluetooth printer, atau permintaan live ke Gemini API. Faktor-faktor tersebut bergantung pada izin akun, browser, perangkat, konfigurasi deployment, dan API key. Karena itu, hasil pemeriksaan source tidak dapat dijadikan jaminan mutlak bahwa tidak ada error pada semua perangkat atau kondisi produksi.

## File yang berubah

- `index.html`
- `app.js`
- `Code.gs`
- `sw.js`
- `README.md`
- `vercel.json`
