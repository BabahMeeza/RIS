# Tombol "Kirim ke RIS" di SIMRS Khanza

Mode `SYNC_MODE=manual` di RIS: order radiologi **hanya** masuk ke RIS saat petugas menekan
tombol di Khanza. Begitu diterima, RIS membuat Accession Number (format Khanza) dan order
**langsung tersedia di Modality Worklist** alat — radiografer tinggal menekan *Query Worklist* /
*Refresh* di alat. Bila HL7 dikonfigurasi, RIS juga mendorong ORM^O01 ke PACS/gateway.

```
Khanza [Kirim ke RIS] --HTTP POST--> RIS --(MWL C-FIND)--> Alat
                                      \--(HL7 ORM, opsional)--> PACS / gateway
```

## 1. Siapkan RIS (.env)

```
SYNC_MODE=manual
KHANZA_API_KEY=<kunci acak panjang, mis. hasil: openssl rand -hex 24>
KHANZA_API_ALLOW=                # opsional: IP PC/server Khanza, pisah koma
```

Restart RIS. Log menampilkan: `Mode kirim MANUAL: order masuk saat dikirim dari Khanza`.

## 2. Pasang di Khanza

1. Salin `RisBridge.java` ke `src/fungsi/RisBridge.java` (package `fungsi`; ganti baris `package` bila diletakkan di tempat lain).
2. Salin `ris.properties.example` menjadi `setting/ris.properties` di folder aplikasi Khanza tiap PC, isi `RIS_URL` dan `RIS_KEY` (= `KHANZA_API_KEY`).
3. Tambahkan tombol di form permintaan radiologi, mis. `DlgCariPermintaanRadiologi` / `DlgPermintaanRadiologi`
   (lewat NetBeans GUI Builder: tambah `widget.Button` bernama `BtnKirimRIS`, teks "Kirim ke RIS"), lalu isi aksinya:

```java
private void BtnKirimRISActionPerformed(java.awt.event.ActionEvent evt) {
    // sesuaikan nama tabel & indeks kolom noorder dengan form Anda
    int baris = tbRadiologiRalan.getSelectedRow();
    if (baris < 0) {
        JOptionPane.showMessageDialog(null, "Silakan pilih permintaan radiologi terlebih dahulu");
        return;
    }
    String noorder = tbRadiologiRalan.getValueAt(baris, 0).toString();   // kolom "No.Permintaan"
    this.setCursor(Cursor.getPredefinedCursor(Cursor.WAIT_CURSOR));
    try {
        com.fasterxml.jackson.databind.JsonNode r = fungsi.RisBridge.kirimOrder(noorder, akses.getkode());
        JOptionPane.showMessageDialog(null, fungsi.RisBridge.ringkas(r),
            r.path("ok").asBoolean() ? "Terkirim ke RIS" : "RIS menolak", 
            r.path("ok").asBoolean() ? JOptionPane.INFORMATION_MESSAGE : JOptionPane.WARNING_MESSAGE);
    } catch (Exception e) {
        JOptionPane.showMessageDialog(null, "Gagal menghubungi RIS: " + e.getMessage());
    }
    this.setCursor(Cursor.getDefaultCursor());
}
```

> `akses.getkode()` = user Khanza yang login (dicatat di jejak order RIS). Ganti/hapus bila tidak tersedia.

### Opsional: batal otomatis saat permintaan dihapus di Khanza

Di aksi hapus permintaan radiologi, setelah DELETE berhasil:

```java
try { fungsi.RisBridge.batalOrder(noorder, null, akses.getkode()); } catch (Exception e) { System.out.println("RIS: " + e); }
```

### Opsional: kirim otomatis saat permintaan disimpan

Panggil `fungsi.RisBridge.kirimOrder(noorder, akses.getkode())` setelah simpan permintaan berhasil
(form `DlgPermintaanRadiologi`), maka tidak perlu menekan tombol terpisah.

## 3. API (untuk referensi / aplikasi lain)

Semua memakai header `X-RIS-Key: <KHANZA_API_KEY>`.

| Method | URL | Body | Keterangan |
|---|---|---|---|
| POST | `/api/khanza/order` | `{"noorder":"PR20261104004","user":"admin"}` | Kirim/ulang kirim satu noorder (idempoten) |
| POST | `/api/khanza/cancel` | `{"noorder":"PR20261104004","kd_jenis_prw":"J000081"}` | Batal (tanpa `kd_jenis_prw` = semua item) |
| GET | `/api/khanza/order/PR20261104004` | – | Status: accession, alat, status, gambar, expertise |

Contoh respons:

```json
{"ok":true,"noorder":"PR20261104004","message":"2 pemeriksaan terkirim ke RIS dan siap di worklist alat",
 "items":[{"nama":"THORAX ANAK (SEDANG)/(AP/PA)","accession":"20261104004J000081","modality":"DX",
           "station":"semua alat DX","status":"SCHEDULED","baru":true}]}
```

Uji dari terminal:

```bash
curl -X POST http://IP-RIS:8090/api/khanza/order -H "X-RIS-Key: KUNCI" -H "Content-Type: application/json" -d '{"noorder":"PR20261104004"}'
```
