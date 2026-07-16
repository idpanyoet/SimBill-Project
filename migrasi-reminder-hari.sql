-- Migrasi setting reminder_hari (dijalankan sekali, aman diulang)
-- Kalau sudah pernah pakai reminder_h lama, jadikan itu nilai awal (mis. '3' -> '3').
-- Kalau belum ada sama sekali, default '1' (H-1, sama seperti perilaku lama).
INSERT INTO setting (kunci, nilai, deskripsi)
SELECT 'reminder_hari',
       COALESCE((SELECT nilai FROM setting WHERE kunci='reminder_h' LIMIT 1), '1'),
       'Jadwal reminder tagihan (daftar hari sebelum jatuh tempo, mis. 3,0)'
WHERE NOT EXISTS (SELECT 1 FROM setting WHERE kunci='reminder_hari');
