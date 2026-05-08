import { Injectable, Logger } from '@nestjs/common';
import { createKafkaClient }  from '../common/kafka.provider';
import { v4 as uuid } from 'uuid';
import type { Producer } from 'kafkajs';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class LoanSaga {
  private logger = new Logger('LoanSaga');
  private kafkaBroker = process.env.KAFKA_BROKER || 'kafka:9092';
  private kafkaProducer?: Producer;
  private localDemoMode = process.env.LOCAL_DEMO_MODE === 'true';
  private auditDir = process.env.AUDIT_DIR || (this.localDemoMode
    ? path.resolve(process.cwd(), '../../audit_logs')
    : '/app/audit_logs');

  constructor() {
    if (!this.localDemoMode) {
      const kafka = createKafkaClient([this.kafkaBroker]);
      // lazy init producer
      (async () => {
        const kp = await import('../common/kafka.provider');
        this.kafkaProducer = await kp.createProducer(kafka);
      })().catch(err => this.logger.error(err));
    }
  }

  private ensureAuditDir() {
    if (!fs.existsSync(this.auditDir)) fs.mkdirSync(this.auditDir, { recursive: true });
  }

  private appendLocalAuditLine(applicationId: string, eventName: string, payload: any) {
    this.ensureAuditDir();
    const file = path.join(this.auditDir, `${applicationId}.log`);
    const line = JSON.stringify({ applicationId, eventName, payload, recordedAt: new Date().toISOString() });
    fs.appendFileSync(file, line + '\n');
  }

  private async executeLocal(applyLoanDto: any) {
    const applicationId = applyLoanDto.applicationId || uuid();
    const userId = applyLoanDto.userId || 'unknown-user';
    const amount = Number(applyLoanDto.amount || 0);

    this.logger.log(`LOCAL_DEMO_MODE enabled for ${applicationId}`);
    this.appendLocalAuditLine(applicationId, 'loan.requested', { applicationId, ...applyLoanDto });

    const kycStatus = applyLoanDto.kycStatus || 'PASSED';
    this.appendLocalAuditLine(applicationId, 'kyc.completed', {
      applicationId,
      userId,
      kycStatus,
      checkedAt: new Date().toISOString(),
    });

    if (kycStatus !== 'PASSED') {
      this.appendLocalAuditLine(applicationId, 'loan.cancelled', {
        applicationId,
        reason: 'KYC_FAILED',
        cancelledAt: new Date().toISOString(),
      });
      return { applicationId, status: 'REJECTED', reason: 'KYC_FAILED' };
    }

    const score = typeof applyLoanDto.creditScore === 'number'
      ? applyLoanDto.creditScore
      : Math.max(300, 780 - Math.round(amount / 10));
    const decision = score < 500 ? 'FAIL' : score < 600 ? 'REVIEW' : 'PASS';
    this.appendLocalAuditLine(applicationId, 'credit.checked', {
      applicationId,
      userId,
      score,
      decision,
      checkedAt: new Date().toISOString(),
    });

    if (decision === 'FAIL') {
      this.appendLocalAuditLine(applicationId, 'loan.cancelled', {
        applicationId,
        reason: 'CREDIT_FAIL',
        cancelledAt: new Date().toISOString(),
      });
      return { applicationId, status: 'REJECTED', reason: 'CREDIT_FAIL' };
    }

    const risk = score < 600 ? 'HIGH' : score < 700 ? 'MEDIUM' : 'LOW';
    this.appendLocalAuditLine(applicationId, 'risk.checked', {
      applicationId,
      userId,
      risk,
      details: { score },
      checkedAt: new Date().toISOString(),
    });

    const blacklisted = (applyLoanDto.blacklisted ?? userId.toLowerCase().includes('bad')) ? true : false;
    this.appendLocalAuditLine(applicationId, 'blacklist.checked', {
      applicationId,
      userId,
      blacklisted,
      reason: blacklisted ? 'MATCHED_BLACKLIST' : undefined,
      checkedAt: new Date().toISOString(),
    });

    if (blacklisted) {
      this.appendLocalAuditLine(applicationId, 'loan.cancelled', {
        applicationId,
        reason: 'BLACKLISTED',
        cancelledAt: new Date().toISOString(),
      });
      return { applicationId, status: 'REJECTED', reason: 'BLACKLISTED' };
    }

    this.appendLocalAuditLine(applicationId, 'loan.approved', {
      applicationId,
      approvedAt: new Date().toISOString(),
      note: 'LOCAL_DEMO_MODE',
    });

    return { applicationId, status: 'APPROVED' };
  }

  private async waitForEvent(topic: string, applicationId: string, timeoutMs = 15000): Promise<any> {
    const kafka = createKafkaClient([this.kafkaBroker]);
    const groupId = `saga-waiter-${uuid()}`;
    const kp = await import('../common/kafka.provider');
    const consumer = await kp.createConsumer(kafka, groupId);
    await consumer.subscribe({ topic, fromBeginning: false });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        try {
          await consumer.disconnect();
        } catch {}
        reject(new Error(`Timeout waiting for ${topic} for ${applicationId}`));
      }, timeoutMs);

      consumer.run({
        eachMessage: async ({ message }) => {
          const key = message.key?.toString();
          if (key !== applicationId) return;
          try {
            const payload = JSON.parse(message.value!.toString());
            clearTimeout(timer);
            await consumer.disconnect();
            resolve(payload);
          } catch (err) {
            clearTimeout(timer);
            await consumer.disconnect();
            reject(err);
          }
        }
      }).catch(async err => {
        clearTimeout(timer);
        try { await consumer.disconnect(); } catch {}
        reject(err);
      });
    });
  }

  async execute(applyLoanDto: any) {
    if (this.localDemoMode) {
      return this.executeLocal(applyLoanDto);
    }

    const applicationId = applyLoanDto.applicationId || uuid();

    // ensure producer ready (simple retry)
    let retry = 0;
    while (!this.kafkaProducer && retry < 20) {
      await new Promise(r => setTimeout(r, 200));
      retry++;
    }
    if (!this.kafkaProducer) throw new Error('Kafka producer not available');

    // STEP 1: emit loan.requested
    await this.kafkaProducer.send({
      topic: 'loan.requested',
      messages: [{ key: applicationId, value: JSON.stringify({ applicationId, ...applyLoanDto }) }],
    });
    this.logger.log(`loan.requested emitted for ${applicationId}`);

    try {
      // Wait KYC
      const kyc = await this.waitForEvent('kyc.completed', applicationId, 20000);
      this.logger.log(`KYC result for ${applicationId}: ${kyc.kycStatus}`);

      if (kyc.kycStatus !== 'PASSED') {
        // compensation: cancel
        await this.kafkaProducer.send({
          topic: 'loan.cancelled',
          messages: [{ key: applicationId, value: JSON.stringify({ applicationId, reason: 'KYC_FAILED', cancelledAt: new Date().toISOString() }) }],
        });
        await this.kafkaProducer.send({
          topic: 'audit.logged',
          messages: [{ key: applicationId, value: JSON.stringify({ applicationId, eventName: 'loan.cancelled', payload: kyc, recordedAt: new Date().toISOString() }) }],
        });
        return { applicationId, status: 'REJECTED', reason: 'KYC_FAILED' };
      }

      // Wait Credit
      const credit = await this.waitForEvent('credit.checked', applicationId, 20000);
      this.logger.log(`Credit result for ${applicationId}: score=${credit.score}`);

      if (credit.decision === 'FAIL') {
        await this.kafkaProducer.send({
          topic: 'loan.cancelled',
          messages: [{ key: applicationId, value: JSON.stringify({ applicationId, reason: 'CREDIT_REJECT', cancelledAt: new Date().toISOString() }) }],
        });
        await this.kafkaProducer.send({
          topic: 'audit.logged',
          messages: [{ key: applicationId, value: JSON.stringify({ applicationId, eventName: 'loan.cancelled', payload: credit, recordedAt: new Date().toISOString() }) }],
        });
        return { applicationId, status: 'REJECTED', reason: 'CREDIT_FAIL' };
      }

      // Wait Risk
      const risk = await this.waitForEvent('risk.checked', applicationId, 20000);
      this.logger.log(`Risk result for ${applicationId}: ${risk.risk}`);

      // Wait Blacklist (this one may result in blacklisted = true)
      const blacklist = await this.waitForEvent('blacklist.checked', applicationId, 20000);
      this.logger.log(`Blacklist result for ${applicationId}: blacklisted=${blacklist.blacklisted}`);

      if (blacklist.blacklisted) {
        // COMPENSATION: cancel loan, rollback state (simulated), log audit
        await this.kafkaProducer.send({
          topic: 'loan.cancelled',
          messages: [{ key: applicationId, value: JSON.stringify({ applicationId, reason: 'BLACKLISTED', cancelledAt: new Date().toISOString() }) }],
        });
        await this.kafkaProducer.send({
          topic: 'audit.logged',
          messages: [{ key: applicationId, value: JSON.stringify({ applicationId, eventName: 'compensation.blacklist', payload: blacklist, recordedAt: new Date().toISOString() }) }],
        });
        await this.kafkaProducer.send({
          topic: 'loan.rolledback',
          messages: [{ key: applicationId, value: JSON.stringify({ applicationId, rolledBackAt: new Date().toISOString() }) }],
        });

        return { applicationId, status: 'REJECTED', reason: 'BLACKLISTED' };
      }

      // If all passed
      await this.kafkaProducer.send({
        topic: 'loan.approved',
        messages: [{ key: applicationId, value: JSON.stringify({ applicationId, approvedAt: new Date().toISOString() }) }],
      });
      await this.kafkaProducer.send({
        topic: 'audit.logged',
        messages: [{ key: applicationId, value: JSON.stringify({ applicationId, eventName: 'loan.approved', payload: {}, recordedAt: new Date().toISOString() }) }],
      });

      return { applicationId, status: 'APPROVED' };
    } catch (err) {
      this.logger.error(`Saga error for ${applicationId}: ${err.message || err}`);
      // best-effort compensation
      await this.kafkaProducer.send({
        topic: 'loan.cancelled',
        messages: [{ key: applicationId, value: JSON.stringify({ applicationId, reason: 'SAGA_ERROR', cancelledAt: new Date().toISOString(), error: String(err) }) }],
      });
      await this.kafkaProducer.send({
        topic: 'audit.logged',
        messages: [{ key: applicationId, value: JSON.stringify({ applicationId, eventName: 'saga.error', payload: String(err), recordedAt: new Date().toISOString() }) }],
      });
      return { applicationId, status: 'ERROR', message: String(err) };
    }
  }
}
