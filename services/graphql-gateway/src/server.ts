import { dynamoHealthCheck, runService } from '@aegisvolt/shared';
import { SERVICE, buildGatewayApp } from './app.js';
import { ServiceClients } from './clients.js';
import { GatewayEvents } from './events.js';
import { DynamoFlagWriter, FlagWatcher } from './flags-admin.js';
import { SagaOrchestrator } from './saga/orchestrator.js';
import { DynamoSagaStore } from './saga/store.js';

await runService(SERVICE, 4000, async ({ config, logger, doc, flags }) => {
  const env = process.env;
  const clients = new ServiceClients({
    reservation: env.RESERVATION_URL ?? 'http://localhost:4001',
    billing: env.BILLING_URL ?? 'http://localhost:4002',
    dispatch: env.DISPATCH_URL ?? 'http://localhost:4003',
  });
  const events = new GatewayEvents();
  const store = new DynamoSagaStore(doc, config.tables.sagas);
  const orchestrator = new SagaOrchestrator({ store, participants: clients, events, logger, env: config.env });
  const flagWatcher = new FlagWatcher(flags, events, logger);

  const app = await buildGatewayApp({
    config,
    logger,
    env: config.env,
    clients,
    orchestrator,
    store,
    flags,
    flagWriter: new DynamoFlagWriter(doc, config.tables.flags),
    flagWatcher,
    events,
    adminToken: env.ADMIN_TOKEN,
    corsOrigins: env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean),
    healthCheck: dynamoHealthCheck(doc, config.tables.sagas),
  });
  app.addHook('onClose', async () => flagWatcher.stop());
  await flagWatcher.start();
  return app;
});
