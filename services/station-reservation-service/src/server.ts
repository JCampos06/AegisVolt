import { dynamoHealthCheck, runService } from '@aegisvolt/shared';
import { SERVICE, buildApp } from './app.js';
import { DynamoReservationRepository } from './repository.js';

await runService(SERVICE, 4001, ({ config, logger, doc, flags }) =>
  buildApp({
    config,
    logger,
    flags,
    repo: new DynamoReservationRepository(doc, config.tables.reservations),
    healthCheck: dynamoHealthCheck(doc, config.tables.reservations),
  }),
);
