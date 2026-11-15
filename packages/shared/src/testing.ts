import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { awsClientOptions } from './aws.js';

/**
 * Utilidades para pruebas de integración contra Floci (DynamoDB real emulado).
 * Cada suite crea su propia tabla efímera (PK/SK, igual que el módulo de
 * Terraform) y la borra al terminar: no toca las tablas de dev/test/prod.
 */
export const INTEGRATION_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

/** true si el emulador responde (cualquier respuesta HTTP sirve). */
export async function flociAvailable(): Promise<boolean> {
  try {
    await fetch(INTEGRATION_ENDPOINT, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

export interface EphemeralTable {
  doc: DynamoDBDocumentClient;
  tableName: string;
  drop(): Promise<void>;
}

export async function createEphemeralTable(prefix: string): Promise<EphemeralTable> {
  const client = new DynamoDBClient(awsClientOptions({ region: 'us-east-1', endpoint: INTEGRATION_ENDPOINT }));
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const tableName = `it-${prefix}-${randomUUID().slice(0, 8)}`;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    }),
  );
  return {
    doc,
    tableName,
    drop: async () => {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      client.destroy();
    },
  };
}
