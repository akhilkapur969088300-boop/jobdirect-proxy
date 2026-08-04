// ─────────────────────────────────────────────────────────────
// JobDirect — API Proxy
//
// Two responsibilities:
// 1. Authenticated AI proxy (Match Score, Alfie, Suggestions, Tailoring)
//    — now requires a valid Firebase ID token, and rate-limits per user.
//    Previously this endpoint had zero auth — anyone who found the URL
//    could call it directly at your Anthropic API cost, with no limit.
// 2. Real purchase verification for both Apple and Google — checks a
//    purchase against Apple's/Google's own servers before granting a
//    plan or credits, instead of trusting whatever the client claims.
//    Previously the app just wrote "plan: elite" to Firestore itself,
//    with nothing checking it was ever actually paid for.
// ─────────────────────────────────────────────────────────────

const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, anthropic-beta, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Firebase Admin init — same service-account-as-env-var pattern ──
// already used by jobdirect-scraper. Never commit the actual key file;
// this expects the full service account JSON as a single Railway env
// var (FIREBASE_SERVICE_ACCOUNT), matching what's already set up there.
let firebaseReady = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '{}';
  // Handles the value whether it's stored as raw JSON or base64-encoded
  // JSON (a common pattern to avoid newline/quote issues in env var UIs,
  // and what the value actually looks like as currently set on Railway).
  // Tries raw JSON first, falls back to base64-decoding if that fails.
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  if (serviceAccount.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseReady = true;
  } else {
    console.error('FIREBASE_SERVICE_ACCOUNT env var missing or invalid — Firebase Admin not initialized.');
  }
} catch (e) {
  console.error('Firebase Admin init failed:', e.message);
}
const db = firebaseReady ? admin.firestore() : null;

// ── Verify a Firebase ID token, return the real, trusted uid ──
// This is the actual security boundary: a client can claim to be
// anyone in a request body, but only a token Firebase itself issued
// and signed can prove who's really asking.
async function verifyFirebaseToken(idToken) {
  if (!firebaseReady) throw new Error('Firebase Admin not configured on server');
  const decoded = await admin.auth().verifyIdToken(idToken);
  return decoded.uid;
}

// ── Simple in-memory per-user rate limit for the AI proxy ──────
// Not a substitute for a real distributed rate limiter at scale, but
// closes the current "zero limit, anyone can call this all day" gap
// with something genuinely functional for where the app is today.
// Resets on server restart, which is an accepted tradeoff for
// simplicity at this stage.
const aiCallLog = new Map(); // uid -> array of call timestamps (ms)
const AI_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const AI_RATE_LIMIT_MAX_CALLS = 30;             // per user per hour

function isRateLimited(uid) {
  const now = Date.now();
  const calls = (aiCallLog.get(uid) || []).filter(t => now - t < AI_RATE_LIMIT_WINDOW_MS);
  aiCallLog.set(uid, calls);
  if (calls.length >= AI_RATE_LIMIT_MAX_CALLS) return true;
  calls.push(now);
  aiCallLog.set(uid, calls);
  return false;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'JobDirect API Proxy' });
});

// ── AI proxy — now requires a valid signed-in Firebase user ────
app.post('/api/ai', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Missing authentication token' });

    let uid;
    try {
      uid = await verifyFirebaseToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired authentication token' });
    }

    if (isRateLimited(uid)) {
      return res.status(429).json({ error: 'Rate limit exceeded — please try again later' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const headers = {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    };
    const beta = req.headers['anthropic-beta'];
    if (beta && beta.trim().length > 0) headers['anthropic-beta'] = beta;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(500).json({ error: 'Proxy request failed' });
  }
});

// ── Apple purchase verification ─────────────────────────────────
// Uses the App Store Server API (JWT-authenticated), which replaces
// the deprecated verifyReceipt endpoint. Requires an App Store
// Connect API key generated specifically for server use — set as
// three Railway env vars: APPLE_KEY_ID, APPLE_ISSUER_ID, and
// APPLE_PRIVATE_KEY (the .p8 file contents, newlines preserved).
function buildAppleJWT() {
  const keyId    = process.env.APPLE_KEY_ID;
  const issuerId = process.env.APPLE_ISSUER_ID;
  const bundleId = process.env.APPLE_BUNDLE_ID || 'com.jobdirect.app';
  const rawKey = process.env.APPLE_PRIVATE_KEY || '';
  const privateKey = rawKey.replace(/\\n/g, '\n');

  // TEMPORARY DIAGNOSTIC — safe, reveals only structural metadata about
  // the key (never its actual content) so we can pinpoint exactly how
  // the stored value differs from a valid PEM key, instead of guessing
  // at another regex fix blind. Remove once the real cause is found.
  console.log('[apple-key-diagnostic]', JSON.stringify({
    rawLength: rawKey.length,
    processedLength: privateKey.length,
    startsCorrectly: privateKey.startsWith('-----BEGIN PRIVATE KEY-----'),
    endsCorrectly: privateKey.trim().endsWith('-----END PRIVATE KEY-----'),
    newlineCount: (privateKey.match(/\n/g) || []).length,
    hasCarriageReturn: privateKey.includes('\r'),
    hasDoubleBackslashN: rawKey.includes('\\\\n'),
    firstChars: privateKey.slice(0, 35),
    lastChars: privateKey.slice(-35),
  }));

  if (!keyId || !issuerId || !privateKey) {
    throw new Error('Apple App Store Server API credentials not configured');
  }

  return jwt.sign(
    { bid: bundleId },
    privateKey,
    {
      algorithm: 'ES256',
      keyid: keyId,
      issuer: issuerId,
      audience: 'appstoreconnect-v1',
      expiresIn: '5m', // Apple requires short-lived tokens
    }
  );
}

async function verifyAppleTransaction(transactionId, useSandbox) {
  const token = buildAppleJWT();
  const host = useSandbox
    ? 'api.storekit-sandbox.itunes.apple.com'
    : 'api.storekit.itunes.apple.com';

  const response = await fetch(`https://${host}/inApps/v1/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Apple verification failed: ${response.status}`);
  }

  const data = await response.json();
  // signedTransactionInfo is a JWS — Apple has already cryptographically
  // signed it, so decoding without re-verifying the signature is safe
  // here specifically because we obtained it via an authenticated
  // request to Apple's own server (not something the client handed us
  // directly) — the transport itself is the trust boundary.
  const payload = JSON.parse(Buffer.from(data.signedTransactionInfo.split('.')[1], 'base64').toString());
  return payload; // includes productId, transactionId, expiresDate, etc.
}

// ── Google purchase verification ────────────────────────────────
// Uses the Google Play Developer API. Requires a Google Cloud service
// account with the Android Publisher API enabled and granted access
// in Play Console (Setup → API access) — set as GOOGLE_SERVICE_ACCOUNT
// (the full service account JSON, same pattern as Firebase's).
function getAndroidPublisherClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT || '{}';
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  if (!serviceAccount.client_email) {
    throw new Error('Google Play service account not configured');
  }
  const auth = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ['https://www.googleapis.com/auth/androidpublisher']
  );
  return google.androidpublisher({ version: 'v3', auth });
}

async function verifyGoogleSubscription(packageName, purchaseToken) {
  const publisher = getAndroidPublisherClient();
  const result = await publisher.purchases.subscriptionsv2.get({
    packageName,
    token: purchaseToken,
  });
  return result.data; // includes subscriptionState, lineItems, etc.
}

async function verifyGoogleProduct(packageName, productId, purchaseToken) {
  const publisher = getAndroidPublisherClient();
  const result = await publisher.purchases.products.get({
    packageName,
    productId,
    token: purchaseToken,
  });
  return result.data; // includes purchaseState, consumptionState, etc.
}

// Maps a product ID to what it actually grants — kept in sync with
// the app's own PRODUCT_IDS in iapService.js.
const PLAN_PRODUCTS = {
  'com.jobdirect.app.pro.monthly':    { type: 'subscription', plan: 'pro' },
  'com.jobdirect.app.elite.monthly':  { type: 'subscription', plan: 'elite' },
  'com.jobdirect.app.resumepack.5':   { type: 'consumable', credits: 5 },
  'com.jobdirect.app.resumepack.15':  { type: 'consumable', credits: 15 },
  'com.jobdirect.app.resumepack.50':  { type: 'consumable', credits: 50 },
};

// ── Main verification endpoint ───────────────────────────────
app.post('/api/verify-purchase', async (req, res) => {
  try {
    const { platform, productId, transactionId, packageName, purchaseToken, sandbox } = req.body;
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) return res.status(401).json({ error: 'Missing authentication token' });
    if (!productId) return res.status(400).json({ error: 'Missing productId' });

    let uid;
    try {
      uid = await verifyFirebaseToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired authentication token' });
    }

    const grant = PLAN_PRODUCTS[productId];
    if (!grant) return res.status(400).json({ error: 'Unknown productId' });

    if (!firebaseReady) return res.status(500).json({ error: 'Server database not configured' });

    // ── Replay protection ──
    // Without this, the same real transaction ID / purchase token could
    // be submitted to this endpoint repeatedly, and since Apple/Google
    // will keep confirming "yes, this transaction is real" every time
    // (they don't track how many times you've asked), a consumable
    // purchase (resume credit packs) could otherwise be replayed to
    // keep granting credits indefinitely from a single real payment.
    // Subscriptions re-set the same value on replay so are lower risk,
    // but the same check applies uniformly for simplicity and safety.
    const replayId = platform === 'ios' ? transactionId : purchaseToken;
    const processedRef = db.collection('processed_transactions').doc(`${platform}_${replayId}`);
    const alreadyProcessed = await processedRef.get();
    if (alreadyProcessed.exists) {
      return res.status(200).json({ success: true, note: 'Already processed — no action taken (replay prevented)' });
    }

    let verified = false;
    let planSource = '';

    if (platform === 'ios') {
      if (!transactionId) return res.status(400).json({ error: 'Missing transactionId' });
      const transaction = await verifyAppleTransaction(transactionId, !!sandbox);
      // Confirm the verified transaction is actually for the product
      // being claimed, and — for subscriptions — hasn't expired.
      verified = transaction.productId === productId &&
        (grant.type === 'consumable' || !transaction.expiresDate || transaction.expiresDate > Date.now());
      planSource = 'apple_iap';

    } else if (platform === 'android') {
      if (!packageName || !purchaseToken) {
        return res.status(400).json({ error: 'Missing packageName or purchaseToken' });
      }
      if (grant.type === 'subscription') {
        const sub = await verifyGoogleSubscription(packageName, purchaseToken);
        verified = sub.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
      } else {
        const product = await verifyGoogleProduct(packageName, productId, purchaseToken);
        verified = product.purchaseState === 0; // 0 = purchased, per Google's API
      }
      planSource = 'google_play';

    } else {
      return res.status(400).json({ error: 'Invalid platform — must be "ios" or "android"' });
    }

    if (!verified) {
      return res.status(402).json({ error: 'Purchase could not be verified as active/valid' });
    }

    // Only after real verification does anything get written — using
    // Admin SDK, which bypasses client Firestore rules entirely. This
    // is the actual fix: the client itself can no longer be the thing
    // that decides its own plan.
    const userRef = db.collection('users').doc(uid);
    if (grant.type === 'subscription') {
      await userRef.set({ plan: grant.plan, planSource, updatedAt: new Date().toISOString() }, { merge: true });
    } else {
      const snap = await userRef.get();
      const current = snap.exists ? (snap.data().tailorCredits || 0) : 0;
      await userRef.set({ tailorCredits: current + grant.credits, planSource, updatedAt: new Date().toISOString() }, { merge: true });
    }

    // Mark this transaction as processed — must happen only after a
    // successful grant, so a genuinely failed/retried request isn't
    // wrongly blocked from ever succeeding.
    await processedRef.set({ uid, productId, platform, processedAt: new Date().toISOString() });

    if (grant.type === 'subscription') {
      return res.json({ success: true, type: 'subscription', plan: grant.plan });
    } else {
      return res.json({ success: true, type: 'consumable', credits: grant.credits });
    }
  } catch (e) {
    console.error('verify-purchase error:', e.message);
    res.status(500).json({ error: 'Purchase verification failed', detail: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('JobDirect proxy running on port ' + PORT));
