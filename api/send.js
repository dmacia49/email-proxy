// /api/send.js
import nodemailer from "nodemailer";
import crypto from "crypto";

// ===== CORS / Origins =====
const ORIGINS = new Set(
  [
    "https://allstatebm.kintone.com",
    process.env.DEV_ORIGIN, // optional dev origin
  ].filter(Boolean)
);

// ===== Sender pool (ENV ONLY — no plaintext fallbacks) =====
// Set env vars like: GMAIL1_USER/GMAIL1_PASS, GMAIL2_USER/GMAIL2_PASS, GMAIL3_USER/GMAIL3_PASS
const SENDER_POOL = [
  {
    label: "PRIMARY",
    user: process.env.GMAIL2_USER,
    pass: process.env.GMAIL2_PASS,
  },
  {
    label: "BACKUP_A",
    user: process.env.GMAIL1_USER,
    pass: process.env.GMAIL1_PASS,
  },
  {
    label: "BACKUP_B",
    user: process.env.GMAIL3_USER,
    pass: process.env.GMAIL3_PASS,
  },
].filter((a) => a.user && a.pass);

// ===== Nodemailer pooled transporters (warm reuse on serverless) =====
const transporterCache = new Map();
function getTransporter(user, pass) {
  const key = String(user);
  if (!transporterCache.has(key)) {
    transporterCache.set(
      key,
      nodemailer.createTransport({
        service: "gmail",
        pool: true,
        maxConnections: Number(process.env.SMTP_MAX_CONN || 2),
        maxMessages: Number(process.env.SMTP_MAX_MSG || 100),
        rateDelta: Number(process.env.SMTP_RATE_DELTA || 1000), // ms window
        rateLimit: Number(process.env.SMTP_RATE_LIMIT || 5), // msgs per window
        socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 30_000),
        auth: { user, pass },
      })
    );
  }
  return transporterCache.get(key);
}

// ===== Helpers =====
function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function b64ApproxBytes(b64) {
  return Math.floor((b64 || "").length * 0.75); // rough: 3/4 of chars
}
function classify(err) {
  const code = err?.responseCode;
  const msg = err?.message || "";
  if (code === 421 || code === 451 || code === 452)
    return { retryable: true, reason: "Temporary failure" };
  if (code === 550 || code === 553 || code === 554)
    return { retryable: false, reason: "Recipient rejected" };
  if (/Daily user sending limit exceeded/i.test(msg))
    return { retryable: false, reason: "Daily limit" };
  if (/ETIMEDOUT|ECONNRESET|Timeout/i.test(msg))
    return { retryable: true, reason: "Network timeout" };
  return { retryable: false, reason: msg || "Unknown error" };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMailBase({ to, subject, body, filename, pdf, attachmentUrl }) {
  return {
    to,
    subject,
    text: body,
    from: undefined, // set per account
    replyTo: "no-reply@allstatebm.com",
    headers: {
      "List-Unsubscribe":
        "<mailto:no-reply@allstatebm.com?subject=unsubscribe>",
    },
    attachments: [
      {
        filename: filename || "invoice.pdf",
        ...(attachmentUrl
          ? { path: attachmentUrl } // prefer URL (no large Buffers)
          : { content: Buffer.from(pdf, "base64") }),
        contentType: "application/pdf",
        contentDisposition: "attachment",
      },
    ],
  };
}

async function sendWithAccount(acc, mailOptions) {
  const transporter = getTransporter(acc.user, acc.pass);
  const opts = { ...mailOptions, from: `Allstate Billing <${acc.user}>` };

  try {
    const info = await transporter.sendMail(opts);
    return { ok: true, account: acc, info };
  } catch (err1) {
    const c1 = classify(err1);
    // Fast-fail policy: only one quick retry on transient errors
    if (c1.retryable) {
      try {
        await sleep(Number(process.env.SMTP_RETRY_DELAY_MS || 250));
        const info2 = await transporter.sendMail(opts);
        return { ok: true, account: acc, info: info2, retried: true };
      } catch (err2) {
        return {
          ok: false,
          account: acc,
          error: err2,
          classify: classify(err2),
        };
      }
    }
    return { ok: false, account: acc, error: err1, classify: c1 };
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (!ORIGINS.has(origin))
    return res.status(403).json({ error: "Forbidden origin" });
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-ABM-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });
  if (!/application\/json/i.test(req.headers["content-type"] || "")) {
    return res.status(415).json({ error: "Unsupported Media Type" });
  }

  // Optional API key
  if (process.env.ABM_API_KEY) {
    if (req.headers["x-abm-key"] !== process.env.ABM_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (!SENDER_POOL.length) {
    return res.status(500).json({ error: "No sender accounts configured" });
  }

  const reqId = crypto.randomUUID();

  // Body can be single or batch
  const payload = req.body || {};
  const isBatch = Array.isArray(payload.messages);
  const messages = isBatch
    ? payload.messages
    : [
        {
          to: payload.to,
          subject: payload.subject,
          body: payload.body,
          pdf: payload.pdf,
          filename: payload.filename,
          attachmentUrl: payload.attachmentUrl,
        },
      ];

  // Basic validation (fail fast)
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    if (!m.subject || !m.body || !m.to || (!m.pdf && !m.attachmentUrl)) {
      return res.status(400).json({
        error: `Message[${i}] missing required fields (subject, body, to, and pdf OR attachmentUrl)`,
      });
    }
    if (!isValidEmail(m.to)) {
      return res
        .status(400)
        .json({ error: `Message[${i}] invalid recipient email` });
    }
    if (m.pdf) {
      const max = Number(process.env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024);
      if (b64ApproxBytes(m.pdf) > max) {
        return res
          .status(413)
          .json({ error: `Message[${i}] attachment too large` });
      }
    }
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "incoming",
      reqId,
      batch: isBatch ? messages.length : 1,
      hasUrlCount: messages.filter((m) => m?.attachmentUrl).length,
      hasPdfCount: messages.filter((m) => m?.pdf).length,
    })
  );

  // === SINGLE SEND (keep simple: primary first, fast failover only on daily limit) ===
  if (!isBatch) {
    const m = messages[0];
    const mailBase = makeMailBase(m);
    let lastError = null;

    for (const acc of SENDER_POOL) {
      const result = await sendWithAccount(acc, mailBase);
      if (result.ok) {
        console.log(
          JSON.stringify({
            level: "info",
            event: "sent",
            reqId,
            sender: acc.user,
            to: m.to,
            messageId: result.info.messageId,
            retried: !!result.retried,
          })
        );
        return res.status(200).json({
          message: "Email sent",
          recipient: m.to,
          sender: acc.user,
          id: result.info.messageId,
          reqId,
        });
      }
      lastError = result.error;
      const reason = result.classify?.reason || lastError?.message || "unknown";
      console.error(
        JSON.stringify({
          level: "error",
          event: "send_fail",
          reqId,
          account: acc.label,
          sender: acc.user,
          to: m.to,
          reason,
          code: lastError?.responseCode,
        })
      );
      // Only switch accounts immediately for daily-limit condition
      if (result.classify && result.classify.reason === "Daily limit") continue;
      // For permanent errors (e.g., invalid recipient), stop early
      if (result.classify && !result.classify.retryable) {
        return res
          .status(502)
          .json({
            error: "Send failed",
            detail: result.classify.reason,
            reqId,
          });
      }
      // Otherwise, try next account
    }

    return res.status(500).json({
      error: "Failed to send email on all accounts",
      detail: lastError?.message || "Unknown error",
      reqId,
    });
  }

  // === BATCH SEND (shard across accounts; fast-fail policy; concise summary) ===
  const disabledForLimit = new Set(); // accounts that hit daily limit
  const perAccount = SENDER_POOL.map((acc) => ({ acc, sent: 0, failed: 0 }));
  const results = [];
  const mailBases = messages.map((m) => makeMailBase(m));

  // Round-robin assignment helper that skips accounts with daily-limit
  function pickAccount(idx) {
    const n = SENDER_POOL.length;
    for (let step = 0; step < n; step++) {
      const a = SENDER_POOL[(idx + step) % n];
      if (!disabledForLimit.has(a.user)) return a;
    }
    return null; // all disabled
  }

  await Promise.all(
    mailBases.map(async (mailBase, i) => {
      const msg = messages[i];
      let acc = pickAccount(i);
      if (!acc) {
        results[i] = {
          ok: false,
          to: msg.to,
          error: "All accounts exhausted (daily limit)",
        };
        return;
      }

      let attemptAcc = acc;
      let attempted = 0;
      let last;

      // At most two account attempts: chosen account, and one fallback if first hit "daily limit"
      while (attempted < 2 && attemptAcc) {
        attempted++;
        const out = await sendWithAccount(attemptAcc, mailBase);
        if (out.ok) {
          const pa = perAccount.find((p) => p.acc.user === attemptAcc.user);
          if (pa) pa.sent++;
          results[i] = {
            ok: true,
            to: msg.to,
            sender: attemptAcc.user,
            id: out.info.messageId,
            retried: !!out.retried,
          };
          console.log(
            JSON.stringify({
              level: "info",
              event: "sent_batch",
              reqId,
              idx: i,
              sender: attemptAcc.user,
              to: msg.to,
              messageId: out.info.messageId,
              retried: !!out.retried,
            })
          );
          return;
        } else {
          last = out;
          const reason =
            out.classify?.reason || out.error?.message || "unknown";
          console.error(
            JSON.stringify({
              level: "error",
              event: "send_batch_fail",
              reqId,
              idx: i,
              account: attemptAcc.label,
              sender: attemptAcc.user,
              to: msg.to,
              reason,
              code: out.error?.responseCode,
            })
          );
          // If daily limit, disable this account for subsequent picks and try one fallback account
          if (out.classify && out.classify.reason === "Daily limit") {
            disabledForLimit.add(attemptAcc.user);
            attemptAcc = pickAccount(i + 1);
            continue;
          }
          // Permanent error: stop
          if (out.classify && !out.classify.retryable) break;
          // Transient already retried once inside sendWithAccount; stop here
          break;
        }
      }

      const pf = perAccount.find(
        (p) => p.acc.user === (acc?.user || SENDER_POOL[0].user)
      );
      if (pf) pf.failed++;
      results[i] = {
        ok: false,
        to: msg.to,
        error: last?.classify?.reason || last?.error?.message || "unknown",
      };
    })
  );

  const summary = {
    reqId,
    total: messages.length,
    success: results.filter((r) => r?.ok).length,
    failed: results.filter((r) => !r?.ok).length,
    perAccount: perAccount.map((p) => ({
      sender: p.acc.user,
      sent: p.sent,
      failed: p.failed,
      disabledForLimit: disabledForLimit.has(p.acc.user),
    })),
    failures: results
      .map((r, i) =>
        !r?.ok ? { index: i, to: messages[i].to, error: r?.error } : null
      )
      .filter(Boolean),
  };

  return res.status(200).json({ message: "Batch processed", summary, results });
}
