/**
 * @file store.mjs
 * Storage for the chat service. One table, pk + sk, TTL on `exp`, index `byLast` (gpk, gsk) for the conversation list.
 * The same small interface on DynamoDB (AWS) and in memory (tests, local runs).
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */

/**
 * Creates the in-memory store used by tests and local runs.
 * @param {function(): number} [clock] - Clock in milliseconds, used to hide expired rows.
 * @returns {Object} The store (`get`, `put`, `del`, `query`, `update`, `byLast`) plus its `rows` map.
 */
export function createMemoryStore(clock = () => Date.now()) {
  const rows = new Map();
  /**
   * Joins a partition key and sort key into one map key.
   * @param {string} pk - Partition key.
   * @param {string} sk - Sort key.
   * @returns {string} The map key.
   */
  const key = (pk, sk) => pk + '\u0000' + sk;
  /**
   * Tells whether a row has not expired.
   * @param {Object} it - The row.
   * @returns {boolean} True when it has no `exp` or `exp` is in the future.
   */
  const live = it => !it.exp || it.exp > clock() / 1000;
  /**
   * Deep-copies a row so callers cannot change stored data.
   * @param {?Object} o - The row.
   * @returns {?Object} The copy, or null for a missing row.
   */
  const copy = o => (o ? structuredClone(o) : null);
  return {
    rows,
    /**
     * Reads one row.
     * @param {string} pk - Partition key.
     * @param {string} sk - Sort key.
     * @returns {Promise<?Object>} The row, or null when it is missing or expired.
     */
    async get(pk, sk) { const it = rows.get(key(pk, sk)); return it && live(it) ? copy(it) : null; },
    /**
     * Writes a row, replacing any existing one.
     * @param {Object} item - The row, with `pk` and `sk`.
     * @param {Object} [opts] - Options.
     * @param {boolean} [opts.ifNotExists] - Only write when no live row has this key.
     * @returns {Promise<boolean>} False when `ifNotExists` was set and a live row exists; otherwise true.
     */
    async put(item, { ifNotExists } = {}) {
      const k = key(item.pk, item.sk), old = rows.get(k);
      if (ifNotExists && old && live(old)) return false;
      rows.set(k, copy(item)); return true;
    },
    /**
     * Deletes one row.
     * @param {string} pk - Partition key.
     * @param {string} sk - Sort key.
     * @returns {Promise<void>}
     */
    async del(pk, sk) { rows.delete(key(pk, sk)); },
    /**
     * Lists a partition's rows in sort-key order.
     * @param {string} pk - Partition key.
     * @param {Object} [opts] - Options.
     * @param {string} [opts.prefix=''] - Only rows whose sort key starts with this.
     * @param {number} [opts.limit=1000] - Most rows to return.
     * @param {string} [opts.before] - Only rows whose sort key is below this.
     * @param {boolean} [opts.reverse=false] - Newest (highest sort key) first.
     * @returns {Promise<Object[]>} The matching live rows.
     */
    async query(pk, { prefix = '', limit = 1000, before, reverse = false } = {}) {
      let out = [...rows.values()].filter(r => r.pk === pk && r.sk.startsWith(prefix) && live(r) && (before === undefined || r.sk < before));
      out.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
      if (reverse) out.reverse();
      return out.slice(0, limit).map(copy);
    },
    /**
     * Changes fields of a row, creating it when it is missing or expired.
     * @param {string} pk - Partition key.
     * @param {string} sk - Sort key.
     * @param {Object} [changes] - What to change.
     * @param {Object} [changes.set] - Fields to overwrite.
     * @param {Object} [changes.add] - Numeric fields to add to (missing counts as 0).
     * @param {Object} [changes.setIfMissing] - Fields to set only when they have no value yet.
     * @returns {Promise<Object>} The row after the change.
     */
    async update(pk, sk, { set = {}, add = {}, setIfMissing = {} } = {}) {
      const k = key(pk, sk), it = rows.get(k) && live(rows.get(k)) ? rows.get(k) : { pk, sk };
      for (const [f, v] of Object.entries(setIfMissing)) if (it[f] === undefined) it[f] = v;
      Object.assign(it, set);
      for (const [f, v] of Object.entries(add)) it[f] = (it[f] || 0) + v;
      rows.set(k, it); return copy(it);
    },
    /**
     * Lists conversations (rows with gpk `CONVS`), most recent `gsk` first.
     * @param {Object} [opts] - Options.
     * @param {number} [opts.limit=50] - Most rows to return.
     * @param {number} [opts.before] - Only rows whose `gsk` is below this.
     * @returns {Promise<Object[]>} The conversation rows.
     */
    async byLast({ limit = 50, before } = {}) {
      return [...rows.values()].filter(r => r.gpk === 'CONVS' && live(r) && (before === undefined || r.gsk < before))
        .sort((a, b) => b.gsk - a.gsk).slice(0, limit).map(copy);
    },
  };
}

/**
 * Creates the DynamoDB-backed store with the same interface as the memory store.
 * DYNAMO_ENDPOINT points local runs at DynamoDB Local (tools/chat-dev.mjs --dynamo).
 * @param {string} table - The table name.
 * @param {Object} [inject] - A document client and command classes to use instead of the AWS SDK (tests).
 * @returns {Promise<Object>} The store (`get`, `put`, `del`, `query`, `update`, `byLast`).
 */
export async function createDynamoStore(table, inject) {
  let db, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand;
  if (inject) ({ db, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } = inject);   // tests
  else {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    ({ GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb'));
    // DYNAMO_ENDPOINT points local runs at DynamoDB Local (tools/chat-dev.mjs --dynamo)
    const local = process.env.DYNAMO_ENDPOINT ? { endpoint: process.env.DYNAMO_ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {};
    db = (await import('@aws-sdk/lib-dynamodb')).DynamoDBDocumentClient.from(new DynamoDBClient(local), { marshallOptions: { removeUndefinedValues: true } });
  }
  /**
   * Current time in whole seconds.
   * @returns {number} Seconds since the epoch.
   */
  const now = () => Math.floor(Date.now() / 1000);
  /**
   * Hides expired rows, because DynamoDB's TTL deletes lazily.
   * @param {?Object} it - A row.
   * @returns {?Object} The row, or null when it is missing or expired.
   */
  const fresh = it => (it && (!it.exp || it.exp > now()) ? it : null);     // TTL deletes lazily; hide expired rows
  return {
    /**
     * Reads one row.
     * @param {string} pk - Partition key.
     * @param {string} sk - Sort key.
     * @returns {Promise<?Object>} The row, or null when it is missing or expired.
     */
    async get(pk, sk) { return fresh((await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item); },
    /**
     * Writes a row, replacing any existing one.
     * @param {Object} item - The row, with `pk` and `sk`.
     * @param {Object} [opts] - Options.
     * @param {boolean} [opts.ifNotExists] - Only write when the key is absent or its row has expired.
     * @returns {Promise<boolean>} False when `ifNotExists` was set and a live row exists; otherwise true.
     * @throws {Error} Any DynamoDB error other than the failed condition.
     */
    async put(item, { ifNotExists } = {}) {
      try {
        await db.send(new PutCommand({ TableName: table, Item: item,
          ...(ifNotExists ? { ConditionExpression: 'attribute_not_exists(pk) OR #e < :now', ExpressionAttributeNames: { '#e': 'exp' }, ExpressionAttributeValues: { ':now': now() } } : {}) }));
        return true;
      } catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
    },
    /**
     * Deletes one row.
     * @param {string} pk - Partition key.
     * @param {string} sk - Sort key.
     * @returns {Promise<void>}
     */
    async del(pk, sk) { await db.send(new DeleteCommand({ TableName: table, Key: { pk, sk } })); },
    /**
     * Lists a partition's rows in sort-key order, following pages until `limit` rows are found.
     * @param {string} pk - Partition key.
     * @param {Object} [opts] - Options.
     * @param {string} [opts.prefix=''] - Only rows whose sort key starts with this.
     * @param {number} [opts.limit=1000] - Most rows to return.
     * @param {string} [opts.before] - Only rows whose sort key is below this.
     * @param {boolean} [opts.reverse=false] - Newest (highest sort key) first.
     * @returns {Promise<Object[]>} The matching live rows.
     */
    async query(pk, { prefix = '', limit = 1000, before, reverse = false } = {}) {
      const names = { '#p': 'pk' }, vals = { ':p': pk };
      let cond = '#p = :p';
      if (prefix || before !== undefined) names['#s'] = 'sk';    // DynamoDB rejects placeholders the expression doesn't use
      if (before !== undefined && prefix) { cond += ' AND #s BETWEEN :a AND :b'; vals[':a'] = prefix; vals[':b'] = before; }
      else if (before !== undefined) { cond += ' AND #s < :b'; vals[':b'] = before; }
      else if (prefix) { cond += ' AND begins_with(#s, :a)'; vals[':a'] = prefix; }
      const out = []; let start;
      do {
        const r = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: cond, ExpressionAttributeNames: names,
          ExpressionAttributeValues: vals, ScanIndexForward: !reverse, Limit: limit - out.length, ExclusiveStartKey: start }));
        out.push(...r.Items.filter(fresh).filter(i => before === undefined || i.sk < before)); start = r.LastEvaluatedKey;
      } while (start && out.length < limit);
      return out;
    },
    /**
     * Changes fields of a row in one UpdateItem call, creating the row when it is missing.
     * @param {string} pk - Partition key.
     * @param {string} sk - Sort key.
     * @param {Object} [changes] - What to change.
     * @param {Object} [changes.set] - Fields to overwrite.
     * @param {Object} [changes.add] - Numeric fields to add to.
     * @param {Object} [changes.setIfMissing] - Fields to set only when they have no value yet.
     * @returns {Promise<Object>} The row after the change.
     */
    async update(pk, sk, { set = {}, add = {}, setIfMissing = {} } = {}) {
      const names = {}, vals = {}, sets = [], adds = [];
      let i = 0;
      for (const [f, v] of Object.entries(set)) { names[`#n${i}`] = f; vals[`:v${i}`] = v; sets.push(`#n${i} = :v${i}`); i++; }
      for (const [f, v] of Object.entries(setIfMissing)) { names[`#n${i}`] = f; vals[`:v${i}`] = v; sets.push(`#n${i} = if_not_exists(#n${i}, :v${i})`); i++; }
      for (const [f, v] of Object.entries(add)) { names[`#n${i}`] = f; vals[`:v${i}`] = v; adds.push(`#n${i} :v${i}`); i++; }
      const expr = [sets.length ? 'SET ' + sets.join(', ') : '', adds.length ? 'ADD ' + adds.join(', ') : ''].join(' ').trim();
      const r = await db.send(new UpdateCommand({ TableName: table, Key: { pk, sk }, UpdateExpression: expr,
        ExpressionAttributeNames: names, ExpressionAttributeValues: vals, ReturnValues: 'ALL_NEW' }));
      return r.Attributes;
    },
    /**
     * Lists conversations from the `byLast` index, most recent first.
     * @param {Object} [opts] - Options.
     * @param {number} [opts.limit=50] - Most rows to return.
     * @param {number} [opts.before] - Only rows whose `gsk` is below this.
     * @returns {Promise<Object[]>} The conversation rows that have not expired.
     */
    async byLast({ limit = 50, before } = {}) {
      const r = await db.send(new QueryCommand({ TableName: table, IndexName: 'byLast', ScanIndexForward: false, Limit: limit,
        KeyConditionExpression: before === undefined ? 'gpk = :g' : 'gpk = :g AND gsk < :b',
        ExpressionAttributeValues: before === undefined ? { ':g': 'CONVS' } : { ':g': 'CONVS', ':b': before } }));
      return r.Items.filter(fresh);
    },
  };
}
