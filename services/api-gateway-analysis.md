**API Gateway Analysis**

- **Summary**: The API Gateway is a small Express proxy providing a public HTTP surface for the microservice system. It implements health checks and proxies key interactions to downstream services (loan-core and audit).

**Available endpoints (implemented)**
- **GET /health**: gateway-level health that probes downstream loan-core instances and the audit service.
  - Implementation: services/api-gateway/src/main.ts
  - Code (excerpt):

```ts
app.get('/health', async (_req, res) => {
  try {
    const loanChecks = await Promise.all(
      LOAN_CORE_SERVERS.map(url =>
        axios.get(url + '/loans/health', { timeout: 2000 })
          .then(r => ({ url, status: r.data }))
          .catch(() => ({ url, status: 'down' }))
      )
    );

    const audit = await axios
      .get(AUDIT_URL + '/health', { timeout: 2000 })
      .catch(() => null);

    res.json({
      status: 'ok',
      loanInstances: loanChecks,
      audit: audit?.data || 'unavailable'
    });

  } catch (err) {
    res.status(500).json({ status: 'error', error: String(err) });
  }
});
```

- **POST /api/loans/apply**: forwards the loan application to a loan-core instance using simple round-robin load balancing.
  - Implementation: services/api-gateway/src/main.ts
  - Code (excerpt):

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

- **GET /api/audit/:id**: proxies to the audit service HTTP endpoint and returns audit log lines.
  - Implementation: services/api-gateway/src/main.ts
  - Code (excerpt):

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

- **GET /api/loans/health**: (added) a small proxy that queries the primary loan-core instance health and exposes it through gateway.
  - Implementation: services/api-gateway/src/main.ts
  - Code (excerpt):

```ts
// LOAN SERVICE HEALTH (PUBLIC)
app.get('/api/loans/health', async (_req, res) => {
  const target = LOAN_CORE_SERVERS[0];

  try {
    const r = await axios.get(target + '/loans/health', { timeout: 5000 });
    res.json(r.data);
  } catch (err: any) {
    res.status(500).json({
      error: String(err),
      target
    });
  }
});
```

**Where orchestration/implementations live**
- API Gateway: services/api-gateway/src/main.ts
- Loan orchestration (Saga): services/loan-core/src/loan/loan.saga.ts and controller services/loan-core/src/loan/loan.controller.ts
- Audit reader + HTTP: services/audit/src/main.ts

**What's NOT available via HTTP on the gateway**
- Direct HTTP endpoints for event-only services: kyc, credit, risk, blacklist. Those services are consumers/producers on Kafka and do not expose HTTP routes by design.
- No admin endpoints for replaying events or inspecting saga state (not implemented).

**Added gateway function and rationale**
- I added GET /api/loans/health to offer a simple public health probe that returns the loan-core health via the gateway. This is useful for load balancers or smoke tests that only reach the gateway.

**How to run locally (no Docker, local demo mode)**
1) Install dependencies in each service folder (run once):
```bash
cd /path/to/repo
npm install
cd services/api-gateway && npm install
cd ../loan-core && npm install
cd ../audit && npm install
# repeat for other services as needed
```

2) Start services in local demo mode (audit and loan-core do not require Kafka in this mode):
```bash
cd services/audit
LOCAL_DEMO_MODE=true npm run start:dev

cd ../loan-core
LOCAL_DEMO_MODE=true PORT=3001 npm run start:dev

cd ../api-gateway
LOAN_CORE_URL=http://localhost:3001 AUDIT_URL=http://localhost:3010 npm run start:dev
```

**Testing (curl examples)**
- Submit a loan application:
```bash
curl -i -X POST http://localhost:3000/api/loans/apply \
  -H "Content-Type: application/json" \
  -d '{"applicationId":"APP01","userId":"good-user","amount":1000,"product":"STD","type":"UNSECURED"}'
```
- Read audit via gateway:
```bash
curl -i http://localhost:3000/api/audit/APP01
```
- Health of loan-core via gateway:
```bash
curl -i http://localhost:3000/api/loans/health
```

**Files changed (where to look)**
- services/api-gateway/src/main.ts (routes and LB)
- services/loan-core/src/loan/loan.saga.ts (local demo path added to support running without Kafka)
- services/audit/src/main.ts (LOCAL_DEMO_MODE support)
- README updated with instructions

**Notes**
- The gateway is intentionally lightweight: it performs HTTP proxying for the primary user flows (apply, audit). Event-driven components are kept as Kafka-only workers.

---

If Anda mau, saya bisa juga menambahkan satu endpoint admin HTTP ke gateway (e.g., `GET /api/saga/:id` to retrieve audit lines for an application) — mau saya tambahkan juga?