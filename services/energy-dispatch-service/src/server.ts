import { dynamoHealthCheck, runService } from '@aegisvolt/shared';
import { SERVICE, buildApp } from './app.js';
import { DynamoDispatchRepository } from './repository.js';

await runService(SERVICE, 4003, ({ config, logger, doc, flags }) =>
  buildApp({
    config,
    logger,
    flags,
    repo: new DynamoDispatchRepository(doc, config.tables.dispatch),
    healthCheck: dynamoHealthCheck(doc, config.tables.dispatch),
  }),
);
