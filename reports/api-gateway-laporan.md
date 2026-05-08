# Laporan Analisis API Gateway

## 1) Tujuan
Dokumen ini dibuat untuk memenuhi tugas:
1. Menganalisis repository saat ini, khususnya fungsi pada API Gateway yang **sudah tersedia** dan **belum tersedia**.
2. Menunjukkan **lokasi implementasi** fungsi API Gateway dengan **kutipan source code**.
3. Mendokumentasikan hasil uji endpoint API yang diminta:
   - `POST http://localhost:3000/api/loans/apply`
   - `GET http://localhost:3000/api/audit/APP01`
4. Mendokumentasikan hasil **penambahan minimal 1 fungsi baru** pada API Gateway.

---

## 2) Lokasi Implementasi API Gateway
Implementasi utama API Gateway berada pada file:

- `services/api-gateway/src/main.ts`

File ini berisi:
- inisialisasi Express,
- konfigurasi target service (`LOAN_CORE_SERVERS`, `AUDIT_URL`),
- routing endpoint publik/admin,
- simple load balancing round-robin,
- health check.

---

## 3) Analisis Fungsi API Gateway

### 3.1 Fungsi yang sudah tersedia
Berdasarkan kode `services/api-gateway/src/main.ts`, endpoint yang sudah tersedia adalah:

1. `GET /health`
   - Health check agregat untuk multi instance loan-core + audit service.
2. `GET /api/loans/health`
   - Health check publik ke loan-core.
3. `POST /api/loans/apply`
   - Proxy request pengajuan pinjaman ke loan-core (dengan round-robin).
4. `GET /api/audit/:id`
   - Proxy pembacaan audit log berdasarkan `applicationId`.
5. `GET /api/saga/:id` (**endpoint tambahan/admin**)
   - Endpoint agregasi data saga: gabungkan hasil audit + health loan-core.

### 3.2 Fungsi yang belum tersedia (gap)
Pada API Gateway saat ini, beberapa fungsi umum yang **belum ada** dan bisa jadi kandidat pengembangan:

1. `GET /api/loans/:id`
   - Belum ada endpoint untuk mengambil detail status aplikasi pinjaman per id dari gateway.
2. `GET /api/saga/:id/status`
   - Belum ada endpoint khusus status ringkas progress saga (mis. tahap saat ini, final state).
3. `GET /api/audit`
   - Belum ada endpoint list audit (pagination/filter) secara umum.
4. `POST /api/admin/replay/:id`
   - Belum ada endpoint admin untuk replay/retrigger alur saga per application id.

Catatan: daftar "belum tersedia" ini adalah analisis kebutuhan fungsional yang umum pada arsitektur gateway-orchestrator, bukan error pada implementasi saat ini.

---

## 4) Kutipan Source Code Implementasi API Gateway

### 4.1 Konfigurasi target service
```ts
const LOAN_CORE_SERVERS = (
  process.env.LOAN_CORE_SERVERS ||
  process.env.LOAN_CORE_URL ||
  'http://localhost:3001'
).split(',').map(url => url.trim()).filter(Boolean);

const AUDIT_URL = process.env.AUDIT_URL || 'http://localhost:3010';
```

### 4.2 Endpoint pengajuan pinjaman (`POST /api/loans/apply`)
```ts
app.post('/api/loans/apply', async (req: Request, res: Response) => {
  const payload = req.body;
  const target = getLoanService();

  try {
    log('Forwarding loan request', { target });

    const r = await axios.post(
      target + '/loans/apply',
      payload,
      { timeout: 60000 }
    );

    res.json(r.data);

  } catch (err: any) {
    log('Loan service error', { target, error: err?.toString() });

    res.status(500).json({
      error: err?.toString(),
      target,
      details: err?.response?.data || null
    });
  }
});
```

### 4.3 Endpoint audit (`GET /api/audit/:id`)
```ts
app.get('/api/audit/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const r = await axios.get(
      `${AUDIT_URL}/audit/${encodeURIComponent(id)}`,
      { timeout: 5000 }
    );

    res.json(r.data);

  } catch (err: any) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'not found' });
    }

    res.status(500).json({ error: String(err) });
  }
});
```

### 4.4 Endpoint tambahan/admin (`GET /api/saga/:id`)
```ts
app.get('/api/saga/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const [auditRes, loanHealthRes] = await Promise.allSettled([
      axios.get(`${AUDIT_URL}/audit/${encodeURIComponent(id)}`, { timeout: 5000 }),
      axios.get(LOAN_CORE_SERVERS[0] + '/loans/health', { timeout: 3000 })
    ]);

    const result: any = { applicationId: id };

    if (auditRes.status === 'fulfilled') result.audit = auditRes.value.data;
    else result.audit = null;

    if (loanHealthRes.status === 'fulfilled') result.loanHealth = loanHealthRes.value.data;
    else result.loanHealth = { error: 'unavailable', details: (loanHealthRes as any).reason?.toString() };

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: String(err) });
  }
});
```

---

## 5) Hasil Pengujian API (Postman)
Pengujian dilakukan melalui Postman untuk memastikan API Gateway berjalan.

### 5.0 Perintah menjalankan service lokal (tanpa Docker)
```bash
cd services/audit
LOCAL_DEMO_MODE=true PORT=3010 npm run start:dev
```

```bash
cd services/loan-core
LOCAL_DEMO_MODE=true PORT=3001 npm run start:dev
```

```bash
cd services/api-gateway
LOAN_CORE_URL=http://localhost:3001 AUDIT_URL=http://localhost:3010 PORT=3000 npm run start:dev
```

Contoh uji cepat via terminal:

```bash
curl -X POST http://localhost:3000/api/loans/apply \
  -H "Content-Type: application/json" \
  -d '{"applicationId":"APP01","userId":"user-1","amount":1000,"product":"STD","type":"UNSECURED"}'

curl http://localhost:3000/api/audit/APP01
```

### 5.1 Endpoint yang diuji sesuai tugas
1. `POST http://localhost:3000/api/loans/apply`
2. `GET http://localhost:3000/api/audit/APP01`

### 5.2 Capture hasil uji
Lampiran screenshot hasil uji yang sudah diupload:

1. ![Capture 1](../img/Screenshot%202026-05-08%20at%2013.30.17.png)
2. ![Capture 2](../img/Screenshot%202026-05-08%20at%2013.30.41.png)
3. ![Capture 3](../img/Screenshot%202026-05-08%20at%2013.31.21.png)
4. ![Capture 4](../img/Screenshot%202026-05-08%20at%2013.31.39.png)

Interpretasi hasil uji merujuk pada capture Postman di atas sebagai bukti eksekusi endpoint.

---

## 6) Dokumentasi Penambahan 1 Fungsi API Gateway
Fungsi baru yang ditambahkan pada API Gateway:

- `GET /api/saga/:id`

### Tujuan penambahan
- Menyediakan endpoint admin untuk melihat ringkasan data proses saga per `applicationId` dalam satu panggilan API.
- Menggabungkan:
  - data audit (`/audit/:id`),
  - status kesehatan loan-core (`/loans/health`).

### Nilai tambah
- Memudahkan observability/debugging alur pengajuan loan pada level gateway.
- Mengurangi kebutuhan call manual ke beberapa service saat troubleshooting.

---

## 7) Kesimpulan
1. API Gateway pada repository ini sudah menyediakan fungsi inti untuk:
   - submit aplikasi loan,
   - membaca audit per id,
   - health check.
2. Endpoint yang diminta tugas (`/api/loans/apply` dan `/api/audit/APP01`) telah diuji dan didokumentasikan melalui capture Postman.
3. Sudah dilakukan penambahan minimal 1 fungsi API Gateway, yaitu endpoint admin `GET /api/saga/:id`, beserta dokumentasinya pada laporan ini.
