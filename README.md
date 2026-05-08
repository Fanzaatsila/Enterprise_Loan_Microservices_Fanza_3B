# Smart Lending Platform - NestJS Microservices Template (with API Gateway)

Overview
- Event-driven microservices for enterprise lending (Kafka).
- Example implemented: loan-core service with Saga orchestrator.
- Services included: API Gateway, loan-core, kyc, credit, risk, blacklist, audit.
- Demonstrates compensation pattern when Blacklist check fails.

API Gateway audit

Already available
- GET /health -> checks gateway + downstream services
- POST /api/loans/apply -> forwards loan application to loan-core
- GET /api/audit/:id -> reads audit log from the audit service
- GET /api/loans/health -> added in this update, proxies loan-core health

Not available from the gateway
- No direct HTTP endpoint for kyc, credit, risk, or blacklist because those services are event consumers.
- No admin endpoint for replaying Kafka events or forcing compensation.
- No endpoint for a combined saga dashboard beyond the gateway health check.

Implementation locations
- API Gateway routes: services/api-gateway/src/main.ts
- Loan orchestration: services/loan-core/src/loan/loan.controller.ts and services/loan-core/src/loan/loan.saga.ts
- Audit reader: services/audit/src/main.ts

Quoted source snippets

services/api-gateway/src/main.ts
```ts
app.post('/api/loans/apply', async (req: Request, res: Response) => {
app.get('/api/audit/:id', async (req, res) => {
app.get('/api/loans/health', async (_req, res) => {
```

services/loan-core/src/loan/loan.controller.ts
```ts
@Post('apply')
async apply(@Body() dto: any) {
  return this.saga.execute(dto);
}
```

services/audit/src/main.ts
```ts
app.get('/audit/:id', (req, res) => {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
```

Requirements
- Node.js 18+
- npm / yarn

Local demo mode no Docker
- Set LOCAL_DEMO_MODE=true.
- Start audit, loan-core, and api-gateway directly with npm run start:dev.
- The audit log directory defaults to the repository-root audit_logs folder.

Quick start (Docker)
1. Copy `.env.example` -> `.env` and customize.
2. Build & start:
   docker-compose up --build -d
3. API Gateway (public): http://localhost:3000
   - POST /api/loans/apply -> start loan flow

Quick dev (no full Docker)
- Start Kafka/Zookeeper:
  docker-compose up -d zookeeper kafka
- Start services locally (each folder):
  cd services/kyc && npm install && npm run start:dev
  cd services/credit && npm install && npm run start:dev
  cd services/risk && npm install && npm run start:dev
  cd services/blacklist && npm install && npm run start:dev
  cd services/audit && npm install && npm run start:dev
  cd services/loan-core && npm install && npm run start:dev
  cd services/api-gateway && npm install && npm run start:dev

Quick dev (no Docker, local demo mode)
1. Install dependencies in root and each service folder with npm install.
2. Start audit:
   cd services/audit && LOCAL_DEMO_MODE=true npm run start:dev
3. Start loan-core:
   cd services/loan-core && LOCAL_DEMO_MODE=true PORT=3001 npm run start:dev
4. Start api-gateway:
   cd services/api-gateway && LOAN_CORE_URL=http://localhost:3001 AUDIT_URL=http://localhost:3010 npm run start:dev
5. Test endpoints:
   POST http://localhost:3000/api/loans/apply
   GET http://localhost:3000/api/audit/APP01

Test examples
- Approve / normal:
    curl -X POST http://localhost:3000/api/loans/apply -H "Content-Type: application/json" -d '{"applicationId":"APP01","userId":"good-user","amount":1000,"product":"STD","type":"UNSECURED"}'
- Force blacklist fail (deterministic):
  curl -X POST http://localhost:3000/api/loans/apply -H "Content-Type: application/json" -d '{"userId":"user-bad-1","amount":1000,"product":"STD","type":"UNSECURED"}'
- Check audit via gateway:
  curl http://localhost:3000/api/audit/APP01
  applicationId = APP01
  the audit data is available at audit_logs/APP01.log 

 # Enterprise_Loan_Microservices_Fanza_3B
