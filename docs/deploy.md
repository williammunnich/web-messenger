# Deploy to the web

This puts the whole messenger in your AWS account: about 30 minutes the first time. Steps 1 to 5 get chat working in a browser. Step 6 adds the iPhone app, and steps 7 and 8 are optional.

Everything runs from `aws/deploy.sh`, either on your Mac with the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) or in AWS CloudShell. If you use CloudShell, upload this repo there first.

## 1. Configure

```sh
cp deploy.env.example deploy.env
```

Fill in `ALLOWED_EMAIL` and `ALLOWED_ORIGINS`. Leave `GOOGLE_CLIENT_ID` until the next step. `deploy.env` is gitignored.

`PREFIX` names every AWS resource, so two copies can live in one account under different prefixes. The script refuses to update a stack of that name that this repo didn't create.

Check your setup at any time. This changes nothing:

```sh
bash aws/deploy.sh check
```

## 2. Create a Google sign-in client

1. Open [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials). Create a project if you don't have one.
2. Configure the consent screen if asked. Choose **External**, and add your own address as a test user.
3. Choose **Create credentials > OAuth client ID > Web application**.
4. Leave the redirect URIs empty for now. You'll add one in step 4.
5. Copy the client ID into `GOOGLE_CLIENT_ID` in `deploy.env`, and keep the client secret for the next step.

## 3. Store secrets and deploy

```sh
bash aws/deploy.sh secrets    # asks for the Google client secret, and optionally the Apple key
bash aws/deploy.sh deploy
```

`secrets` makes a random session key and stores everything encrypted in SSM. Press Enter at the Apple key prompt if you're skipping the app for now; you can run it again later.

`deploy` runs the tests, then creates the stack, and prints your addresses.

## 4. Finish Google sign-in

Copy the **Google redirect URI** that `deploy` printed into your OAuth client's **Authorized redirect URIs**. Then open the **Inbox** address and sign in. Google can take a few minutes to apply the change.

## 5. Add the widget to your site

The `deploy` output includes the tag, which goes before `</body>`:

```html
<script src="https://YOUR-API/widget/chat.js" defer></script>
```

If your site sends a Content-Security-Policy, allow the API host in `script-src` and `style-src`, and the socket host in `connect-src`.

To try it before touching your site, open the **Demo page** address.

## 6. Connect the iPhone app

1. In your Apple developer account, go to **Keys > +**, enable **Apple Push Notifications service (APNs)**, and download the `.p8`. Apple only lets you download it once.
2. Set `APNS_TEAM_ID` and `APNS_TOPIC` in `deploy.env`. The topic is your app's bundle id.
3. Run `bash aws/deploy.sh secrets` and give it the `.p8` path, then run `bash aws/deploy.sh deploy`.
4. Build the app using [ios/README.md](../ios/README.md), and sign in with the **Inbox** address.
5. In the app, use **Settings > Send test notification**.

## 7. Your own hostnames (optional)

The long `amazonaws.com` addresses work, but you can use your own:

1. In AWS Certificate Manager, in the same region as the stack, request a certificate covering both hostnames, such as `chat.example.com` and `inbox.example.com`.
2. Set `CHAT_DOMAIN`, `INBOX_DOMAIN` and `CERT_ARN` in `deploy.env`. If your DNS is in Route 53, also set `HOSTED_ZONE_ID` and the records are written for you. Otherwise, add the CNAMEs that `deploy` prints.
3. Run `bash aws/deploy.sh deploy`.
4. Add `https://inbox.example.com/oauth2/callback` to your Google client's redirect URIs, and update the script tag on your site.

## 8. Email into the inbox (optional)

> **Warning:** this changes where mail for your domain goes. Pointing MX at SES sends **all** of the domain's mail to SES. Only `MAIL_ADDRESS` reaches the inbox; the rest is dropped. If you already have mailboxes on the domain, use a subdomain such as `chat.example.com` instead.

1. Verify your domain in Amazon SES, in a [region that receives email](https://docs.aws.amazon.com/ses/latest/dg/regions.html#region-receive-email).
2. Set `MAIL_ADDRESS` and `FROM_ADDRESS` in `deploy.env`, then run `bash aws/deploy.sh deploy`.
3. Activate the rule set: `aws ses set-active-receipt-rule-set --rule-set-name <PREFIX>-inbound`. An account has one active rule set, so this replaces any other.
4. Add an MX record: `10 inbound-smtp.<region>.amazonaws.com`.
5. New SES accounts can only send to verified addresses. To reply to anyone, request production access in the SES console.

## After deploying: check what local testing can't

- [ ] The inbox redirects to Google, and refuses a different Google account
- [ ] The demo page shows the bubble and your message appears in the inbox
- [ ] Your reply appears in the widget
- [ ] The widget on your own site connects (if it doesn't, check `ALLOWED_ORIGINS`, which must match exactly, with `https://` and no trailing slash)
- [ ] Reminders arrive about a minute after an unanswered message
- [ ] The app receives a test notification

To run the end-to-end test against the deployed stack, sign in to the inbox and copy the `wm_s` cookie from your browser's developer tools. It leaves one blocked test conversation behind.

```sh
SMOKE_BASE=https://YOUR-API SMOKE_ORIGIN=https://YOUR-SITE SMOKE_TOKEN=<cookie value> npm run smoke
```

`bash aws/deploy.sh logs` follows the function's logs.

## Updating and removing

Run `bash aws/deploy.sh deploy` again after any change. The widget is cached for 5 minutes.

To remove everything:

```sh
aws cloudformation delete-stack --stack-name <PREFIX>
```

The table is kept on purpose so conversations can't be lost by accident. Delete it in the DynamoDB console if you want it gone, and do that before redeploying with the same prefix. Also delete the `/<PREFIX>/*` SSM parameters and the `<PREFIX>-deploy-…` S3 bucket.
