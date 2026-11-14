/**
 * @file handler.mjs
 * AWS Lambda entry: WebSocket API events, the HTTP API (/owner/*, sign-in, the inbox and widget), reminders and email.
 * `route` holds all the event mapping and takes no AWS clients, so tools/chat-dev.mjs runs the same code locally.
 *
 * @project web-messenger
 * @author Claude (Anthropic), written for and prompted by William Munnich
 * @date Last edited 2026-11-12
 */
import { createService } from './service.mjs';
import { createDynamoStore } from './store.mjs';
import { createApns } from './apns.mjs';
import { createAuth } from './auth.mjs';
import { createWeb } from './web.mjs';
import { parseEmail } from './mail.mjs';

/** The built service objects, kept between invocations of a warm Lambda. */
let app;
/**
 * Builds the service, sign-in and page handlers once, wired to the real AWS clients (SSM, API Gateway, SQS, SES, S3, DynamoDB).
 * @returns {Promise<{svc: Object, auth: Object, web: function, readMail: function}>} The parts `route` needs.
 */
async function build() {
  if (app) return app;
  const env = process.env;
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({});
  const params = {};
  /**
   * Reads a decrypted SSM parameter, caching it for the life of the Lambda instance.
   * @param {string} name - The parameter name.
   * @returns {Promise<string>} The parameter's value.
   */
  const param = async name => (params[name] ??= (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter.Value);

  const { ApiGatewayManagementApiClient, PostToConnectionCommand } = await import('@aws-sdk/client-apigatewaymanagementapi');
  const gw = new ApiGatewayManagementApiClient({ endpoint: env.WS_ENDPOINT });
  /**
   * Sends a JSON message to one WebSocket connection.
   * @param {string} connId - The API Gateway connection id.
   * @param {Object} msg - The message to send.
   * @returns {Promise<string>} `ok`, `gone` when the connection no longer exists, or `error`.
   */
  async function post(connId, msg) {
    try { await gw.send(new PostToConnectionCommand({ ConnectionId: connId, Data: Buffer.from(JSON.stringify(msg)) })); return 'ok'; }
    catch (e) { return e.name === 'GoneException' || e.$metadata?.httpStatusCode === 410 ? 'gone' : 'error'; }
  }

  const apns = createApns(async () => ({ keyPem: await param(env.APNS_KEY_PARAM), keyId: await param(env.APNS_KEY_ID_PARAM), teamId: env.APNS_TEAM_ID }));

  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const sqs = new SQSClient({});
  /**
   * Queues a reminder job on the SQS delay queue; does nothing when no queue is configured.
   * @param {Object} job - The job the service will get back in `remind`.
   * @param {number} delay - Delay in seconds (capped at 900, the SQS maximum).
   * @returns {Promise<void>}
   */
  const schedule = async (job, delay) => {
    if (!env.REMIND_QUEUE_URL) return;
    await sqs.send(new SendMessageCommand({ QueueUrl: env.REMIND_QUEUE_URL, MessageBody: JSON.stringify(job), DelaySeconds: Math.min(900, delay) }));
  };

  /**
   * Sends a reply to an email conversation through SES (optional: FROM_ADDRESS), with the owner's name and site as a footer.
   * @param {Object} mail - The email to send.
   * @param {string} mail.to - Recipient address.
   * @param {string} mail.subject - Subject line.
   * @param {string} mail.text - Plain-text body.
   * @param {string} [mail.inReplyTo] - Message-ID being answered, so mail clients thread the reply.
   * @returns {Promise<void>}
   * @throws {Error} When FROM_ADDRESS is not set.
   */
  const sendEmail = async ({ to, subject, text, inReplyTo }) => {
    if (!env.FROM_ADDRESS) throw new Error('email is not set up');
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const headers = inReplyTo ? [{ Name: 'In-Reply-To', Value: inReplyTo }, { Name: 'References', Value: inReplyTo }] : [];
    const footer = '\n\n--\n' + env.OWNER_NAME + (env.SITE_URL ? '\n' + env.SITE_URL : '');
    await new SESv2Client({}).send(new SendEmailCommand({ FromEmailAddress: env.FROM_ADDRESS, Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text + footer } }, Headers: headers } } }));
  };

  /**
   * Loads the key that signs sessions.
   * @returns {Promise<string>} The session key from SSM.
   */
  const sessionKey = () => param(env.SESSION_KEY_PARAM);
  const allowedEmail = (env.ALLOWED_EMAIL || '').toLowerCase();
  const svc = createService({ schedule, sendEmail, post, push: apns, sessionKey, allowedEmail,
    store: await createDynamoStore(env.TABLE), apnsTopic: env.APNS_TOPIC, criticalAlerts: env.CRITICAL_ALERTS === '1',
    ownerName: env.OWNER_NAME, siteUrl: env.SITE_URL, wsUrl: env.WS_URL,
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
  });
  const auth = createAuth({ sessionKey, allowedEmail, clientId: env.GOOGLE_CLIENT_ID, clientSecret: () => param(env.GOOGLE_SECRET_PARAM),
    log: o => console.log(JSON.stringify(o)) });
  const web = createWeb({ auth, wsUrl: env.WS_URL, ownerName: env.OWNER_NAME });

  /**
   * Reads a raw incoming email that SES stored in the mail bucket.
   * @param {string} messageId - The SES message id (the object is `inbound/<messageId>`).
   * @returns {Promise<string>} The raw message as a latin1 string.
   */
  async function readMail(messageId) {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const obj = await new S3Client({}).send(new GetObjectCommand({ Bucket: env.MAIL_BUCKET, Key: 'inbound/' + messageId }));
    return obj.Body.transformToString('latin1');
  }
  return (app = { svc, auth, web, readMail });
}

/**
 * The Lambda handler.
 * @param {Object} event - An API Gateway (WebSocket or HTTP), SQS or SES event.
 * @returns {Promise<Object>} The response for that kind of event.
 */
export const handler = async event => route(await build(), event);

/**
 * Maps one event to the service: SES mail, SQS reminders, WebSocket connect/disconnect/message, then the HTTP API
 * (visitor data, /owner/*, sign-in and pages).
 * @param {{svc: Object, auth: Object, web: function, readMail: function}} app - The parts from `build` (or the local bench's stand-ins).
 * @param {Object} event - The Lambda event.
 * @returns {Promise<Object>} The response in the shape the event source expects; 404 for an unknown HTTP path.
 */
export async function route({ svc, auth, web, readMail }, event) {
  const rc = event.requestContext || {};

  if (Array.isArray(event.Records) && event.Records[0]?.eventSource === 'aws:ses') {   // email to the inbox address (SES stored it in S3)
    for (const r of event.Records) {
      const mail = r.ses.mail, rcpt = r.ses.receipt;
      try {
        const parsed = parseEmail(await readMail(mail.messageId));
        await svc.email({ ...parsed, spam: rcpt.spamVerdict?.status === 'FAIL', virus: rcpt.virusVerdict?.status === 'FAIL' });
      } catch (e) { console.log(JSON.stringify({ event: 'email_failed', error: String(e.message || e).slice(0, 200) })); }
    }
    return { disposition: 'STOP_RULE' };
  }
  if (Array.isArray(event.Records)) {                                      // reminders, from the SQS delay queue
    for (const r of event.Records) { try { await svc.remind(JSON.parse(r.body)); } catch (e) { console.log(JSON.stringify({ event: 'remind_failed', error: String(e.message || e) })); } }
    return {};
  }

  if (rc.eventType === 'CONNECT') {
    const code = await svc.wsConnect({ connId: rc.connectionId, query: event.queryStringParameters || {},
      headers: Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), ip: rc.identity?.sourceIp || '' });
    return { statusCode: code };
  }
  if (rc.eventType === 'DISCONNECT') { await svc.wsDisconnect(rc.connectionId); return { statusCode: 200 }; }
  if (rc.eventType === 'MESSAGE') {
    const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    await svc.wsMessage(rc.connectionId, body);            // replies are posted back on the socket by the service
    return { statusCode: 200 };
  }

  // HTTP API (payload v2)
  const req = { method: rc.http?.method || 'GET', path: event.rawPath || '/', host: rc.domainName || '', query: event.queryStringParameters || {},
    headers: event.headers || {}, cookies: event.cookies || [], ip: rc.http?.sourceIp || '' };
  if (req.path === '/visitor/data' || req.path === '/visitor/forget') {     // a visitor's own data: see it or delete it
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
    const hdrs = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const r = await svc.visitorHttp({ method: req.method, path: req.path, headers: hdrs, body, ip: req.ip });
    return { statusCode: r.status, headers: r.headers, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  }
  if (req.path.startsWith('/owner/')) {
    const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
    const r = await svc.http({ ...req, body });
    return { statusCode: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(r.body) };
  }
  const r = (await auth.handle(req)) || (await web(req));
  if (!r) return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found.' };
  return { statusCode: r.status, headers: r.headers || {}, cookies: r.cookies || [], body: r.body };
}
