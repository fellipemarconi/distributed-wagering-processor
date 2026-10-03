import type { Provider } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CONFIG, type Config } from '../config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(config: Config): SQSClient {
  return new SQSClient({
    region: config.awsRegion,
    endpoint: config.awsEndpointUrl,
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 1500, throwOnRequestTimeout: true },
  });
}

export const sqsProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [CONFIG],
  useFactory: createSqsClient,
};
