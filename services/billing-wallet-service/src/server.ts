import { dynamoHealthCheck, runService } from '@aegisvolt/shared';
import { SERVICE, buildApp } from './app.js';
import { DynamoBillingRepository } from './repository.js';

await runService(SERVICE, 4002, ({ config, logger, doc, flags }) =>
  buildApp({
    config,
    logger,
    flags,
    repo: new DynamoBillingRepository(doc, config.tables.billing),
    healthCheck: dynamoHealthCheck(doc, config.tables.billing),
  }),
);
