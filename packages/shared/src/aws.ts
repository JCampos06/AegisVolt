import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { ServiceConfig } from './config.js';

/**
 * Opciones comunes de los clientes AWS. Con Floci (endpoint local) y sin
 * credenciales en el entorno se usan las credenciales de prueba `test/test`.
 */
export function awsClientOptions(aws: ServiceConfig['aws']) {
  const useEmulatorCreds = Boolean(aws.endpoint) && !process.env.AWS_ACCESS_KEY_ID;
  return {
    region: aws.region,
    ...(aws.endpoint ? { endpoint: aws.endpoint } : {}),
    ...(useEmulatorCreds ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
    maxAttempts: 2,
  };
}

export function createDocClient(aws: ServiceConfig['aws']): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(awsClientOptions(aws)), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function createLogsClient(aws: ServiceConfig['aws']): CloudWatchLogsClient {
  return new CloudWatchLogsClient(awsClientOptions(aws));
}

/** Nombre del error de una escritura condicional rechazada. */
export function isConditionalFailure(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}
