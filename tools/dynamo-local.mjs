/**
 * @file dynamo-local.mjs
 * Creates the table in DynamoDB Local from the same key schema as aws/chat/template.yaml (aws/chat/test/standalone.test.mjs checks they match).
 * Used by the local bench (tools/chat-dev.mjs --dynamo).
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-14
 */
/** The table's billing mode, keys and `byLast` index, in CreateTable form. */
export const TABLE_SCHEMA = {
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' },
    { AttributeName: 'gpk', AttributeType: 'S' }, { AttributeName: 'gsk', AttributeType: 'N' }],
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  GlobalSecondaryIndexes: [{ IndexName: 'byLast', KeySchema: [{ AttributeName: 'gpk', KeyType: 'HASH' }, { AttributeName: 'gsk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }],
};
/**
 * Creates the table in DynamoDB Local when it does not exist yet.
 * @param {string} endpoint - The DynamoDB Local address.
 * @param {string} TableName - The table to create.
 * @returns {Promise<void>}
 * @throws {Error} Any error other than "the table already exists".
 */
export async function ensureTable(endpoint, TableName) {
  const { DynamoDBClient, CreateTableCommand, ResourceInUseException } = await import('@aws-sdk/client-dynamodb');
  const db = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  try { await db.send(new CreateTableCommand({ TableName, ...TABLE_SCHEMA })); console.log('created table', TableName); }
  catch (e) { if (!(e instanceof ResourceInUseException)) throw e; }
}
