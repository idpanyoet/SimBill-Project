## v1.6.1 — 8 Juli 2026

Lanjutan v1.6.0: dukungan OLT multi-vendor (ZTE + VSOL + HIOSO), laporan
pembayaran per petugas, serta sejumlah penyempurnaan pelanggan, portal, dan ekspor.

### ✨ Fitur Baru

**Manajemen OLT Multi-Vendor (ZTE + VSOL + HIOSO)**
- Dukungan OLT EPON via SNMP: **VSOL** (V1600D) & **HIOSO** (HA7304C), berdampingan dengan OLT ZTE GPON (SSH) — satu panel untuk semua.
- Pemilih OLT di halaman Manajemen OLT untuk berpindah antar-OLT.
- Form Tambah/Edit OLT punya pilihan Vendor (ZTE/VSOL/HSGQ/HIOSO) & Tipe (GPON/EPON). Untuk OLT EPON cukup isi Community & Port SNMP.
- Daftar ONU EPON menampilkan port, MAC, dan status online. Penautan ONU ke pelanggan tetap tersedia.
- Modal detail ONU menyesuaikan jenis OLT (EPON menampilkan info monitoring, tanpa aksi CLI yang tidak didukung).
- OLT dengan agent SNMP lambat (HIOSO) di-cache & disegarkan otomatis di latar belakang agar panel tetap responsif.

**Laporan Pembayaran per Petugas**
- Rekap siapa yang memproses pembayaran (jumlah transaksi & total rupiah per petugas), tampil di Laporan Pelanggan mengikuti periode terpilih.

**Data Pelanggan**
- Foto depan rumah tersimpan saat pendaftaran (terpisah dari foto KTP).
- Kolom ID Pelanggan tampil di tabel & detail pelanggan (dipakai untuk login portal).
- Impor CSV pelanggan mendukung kolom siklus (postpaid/prepaid) & periode (tetap/kalender); ekspor pun menyertakannya.

**Portal & Ekspor**
- Portal Pelanggan: daftar Perangkat Terhubung mendukung ONU di ACS Lite (dengan pesan akurat bila perangkat tak melaporkan datanya).
- Ekspor Pengeluaran (Excel & CSV) menyertakan tautan bukti transaksi.

### 🔧 Penyempurnaan
- Menu OLT dinamai ulang menjadi "OLT MNT"; menu ACS Lite menjadi "ACS Lite Cloud".
- Urutan menu Keuangan dirapikan (Net Profit dipindah ke bawah).
- Label ONU pada OLT EPON dirapikan; penautan & tampilan konsisten antara tabel dan modal.
- Notifikasi gangguan ONU (Telegram) hanya untuk OLT ZTE (EPON tidak punya data cause via SNMP).

### 📌 Catatan
- OLT EPON (VSOL/HIOSO) bersifat monitoring: RX power per-ONU, traffic, dan aksi provisioning (register/reboot/tulis) tidak tersedia via SNMP — fitur tersebut khusus OLT ZTE.
- Atribusi "pembayaran per petugas" berlaku sejak versi ini; pembayaran lama tercatat sebagai "Online / Gateway".
- Membutuhkan paket npm `net-snmp` di server (untuk driver OLT EPON).
