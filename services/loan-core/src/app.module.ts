import { Module } from '@nestjs/common';
import { LoanModule } from './loan/loan.module';
import { TypeOrmModule } from '@nestjs/typeorm';

const LOCAL_DEMO_MODE = process.env.LOCAL_DEMO_MODE === 'true';

const imports: any[] = [LoanModule];

if (!LOCAL_DEMO_MODE) {
  imports.push(
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.PG_LOAN_HOST || 'pg_loan_core',
      port: Number(process.env.PG_LOAN_PORT || 5432),
      username: process.env.PG_LOAN_USER || 'loan',
      password: process.env.PG_LOAN_PASSWORD || 'loanpass',
      database: process.env.PG_LOAN_DB || 'loan_core',
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      synchronize: true,
    }),
  );
}

@Module({
  imports,
})
export class AppModule {}
