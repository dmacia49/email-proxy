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
// Configure in env: GMAIL1_USER/GMAIL1_PASS, GMAIL2_USER/GMAIL2_PASS, GMAIL3_USER/GMAIL3_PASS
const SENDER_POOL = [
  {
    label: "PRIMARY",
    user: process.env.GMAIL1_USER,
    pass: process.env.GMAIL1_PASS,
  },
  {
    label: "BACKUP_A",
    user: process.env.GMAIL2_USER,
    pass: process.env.GMAIL2_PASS,
  },
  {
    label: "BACKUP_B",
    user: process.env.GMAIL3_USER,
    pass: process.env.GMAIL3_PASS,
  },
].filter((a) => a.user && a.pass);

if (!SENDER_POOL.length) {
  console.warn("[WARN] No sender accounts configured via env vars.");
}

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
  if (/Daily user sending limit exceeded/i.test(msg))
    return { retryable: false, reason: "Daily limit" };
  if (code === 550 || code === 553 || code === 554)
    return { retryable: false, reason: "Recipient rejected" };
  if (code === 421 || code === 451 || code === 452)
    return { retryable: true, reason: "Temporary failure" };
  if (/ETIMEDOUT|ECONNRESET|Timeout/i.test(msg))
    return { retryable: true, reason: "Network timeout" };
  return { retryable: false, reason: msg || "Unknown error" };
}

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
          : { content: Buffer.from(pdf, "base64") }), // fallback to base64 content
        contentType: "application/pdf",
        contentDisposition: "attachment",
      },
    ],
  };
}

async function sendOnceWithAccount(acc, mailOptions) {
  const transporter = getTransporter(acc.user, acc.pass);
  const opts = { ...mailOptions, from: `Allstate Billing <${acc.user}>` }; // consistent branding
  try {
    const info = await transporter.sendMail(opts);
    return { ok: true, account: acc, info };
  } catch (error) {
    const cls = classify(error);
    return { ok: false, account: acc, error, classify: cls };
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
  const body = req.body || {};
  const isBatch = Array.isArray(body.messages);

  // ---- Validate inputs (single or batch) ----
  const toValidate = isBatch
    ? body.messages
    : [
        {
          to: body.to,
          subject: body.subject,
          body: body.body,
          pdf: body.pdf,
          filename: body.filename,
          attachmentUrl: body.attachmentUrl,
        },
      ];

  for (let i = 0; i < toValidate.length; i++) {
    const m = toValidate[i] || {};
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

  // ---- SINGLE SEND (use PRIMARY; if daily limit, try next available account) ----
  if (!isBatch) {
    const msg = toValidate[0];
    const mailBase = makeMailBase(msg);
    let lastError;

    for (const acc of SENDER_POOL) {
      const out = await sendOnceWithAccount(acc, mailBase);
      if (out.ok) {
        console.log(
          JSON.stringify({
            level: "info",
            event: "sent",
            reqId,
            sender: acc.user,
            to: msg.to,
            messageId: out.info.messageId,
          })
        );
        return res.status(200).json({
          message: "Email sent",
          recipient: msg.to,
          sender: acc.user,
          id: out.info.messageId,
          reqId,
        });
      }
      lastError = out.error;
      const reason = out.classify?.reason || out.error?.message || "unknown";
      console.error(
        JSON.stringify({
          level: "error",
          event: "send_fail",
          reqId,
          account: acc.label,
          sender: acc.user,
          to: msg.to,
          reason,
          code: out.error?.responseCode,
        })
      );
      // Only move to next account on daily-limit; otherwise stop
      if (!(out.classify && out.classify.reason === "Daily limit")) {
        return res
          .status(502)
          .json({ error: "Send failed", detail: reason, reqId });
      }
      // else: try next account
    }

    return res.status(500).json({
      error: "Failed to send email on all accounts",
      detail: lastError?.message || "Unknown error",
      reqId,
    });
  }

  // ---- BATCH SEND (parallel; round-robin across accounts; disable accounts on daily limit) ----
  const messages = body.messages;
  const mailBases = messages.map((m) => makeMailBase(m));
  const disabledForLimit = new Set(); // accounts that hit daily limit
  const perAccountStats = SENDER_POOL.map((acc) => ({
    user: acc.user,
    label: acc.label,
    sent: 0,
    failed: 0,
    disabledForLimit: false,
  }));

  function pickAccount(startIndex = 0) {
    const n = SENDER_POOL.length;
    for (let step = 0; step < n; step++) {
      const acc = SENDER_POOL[(startIndex + step) % n];
      if (!disabledForLimit.has(acc.user)) return acc;
    }
    return null; // all disabled
  }

  const results = await Promise.all(
    mailBases.map(async (mailBase, i) => {
      const msg = messages[i];
      // round-robin starting at i; skip disabled accounts
      let acc = pickAccount(i);
      if (!acc) {
        return {
          ok: false,
          to: msg.to,
          error: "All accounts exhausted (daily limit)",
        };
      }

      const out = await sendOnceWithAccount(acc, mailBase);
      if (out.ok) {
        const pa = perAccountStats.find((p) => p.user === acc.user);
        if (pa) pa.sent++;
        console.log(
          JSON.stringify({
            level: "info",
            event: "sent_batch",
            reqId,
            idx: i,
            sender: acc.user,
            to: msg.to,
            messageId: out.info.messageId,
          })
        );
        return {
          ok: true,
          to: msg.to,
          sender: acc.user,
          id: out.info.messageId,
        };
      } else {
        const reason = out.classify?.reason || out.error?.message || "unknown";
        // If daily limit, disable this account and immediately reassign this message once to another available account
        if (out.classify && out.classify.reason === "Daily limit") {
          disabledForLimit.add(acc.user);
          const pa = perAccountStats.find((p) => p.user === acc.user);
          if (pa) {
            pa.disabledForLimit = true;
          }
          const fallback = pickAccount(i + 1);
          if (fallback) {
            const retryOut = await sendOnceWithAccount(fallback, mailBase);
            if (retryOut.ok) {
              const pb = perAccountStats.find((p) => p.user === fallback.user);
              if (pb) pb.sent++;
              console.log(
                JSON.stringify({
                  level: "info",
                  event: "sent_batch_reassigned",
                  reqId,
                  idx: i,
                  sender: fallback.user,
                  to: msg.to,
                  messageId: retryOut.info.messageId,
                })
              );
              return {
                ok: true,
                to: msg.to,
                sender: fallback.user,
                id: retryOut.info.messageId,
                reassigned: true,
              };
            } else {
              const rReason =
                retryOut.classify?.reason ||
                retryOut.error?.message ||
                "unknown";
              const pf = perAccountStats.find((p) => p.user === fallback.user);
              if (pf) pf.failed++;
              console.error(
                JSON.stringify({
                  level: "error",
                  event: "send_batch_fail_reassigned",
                  reqId,
                  idx: i,
                  sender: fallback.user,
                  to: msg.to,
                  reason: rReason,
                  code: retryOut.error?.responseCode,
                })
              );
              return { ok: false, to: msg.to, error: rReason };
            }
          }
          // no fallback available
          const pfNone = perAccountStats.find((p) => p.user === acc.user);
          if (pfNone) pfNone.failed++;
          console.error(
            JSON.stringify({
              level: "error",
              event: "send_batch_fail_no_fallback",
              reqId,
              idx: i,
              sender: acc.user,
              to: msg.to,
              reason,
            })
          );
          return {
            ok: false,
            to: msg.to,
            error: "All accounts exhausted (daily limit)",
          };
        }

        // Non daily-limit failure: record and fail (no retry)
        const pf = perAccountStats.find((p) => p.user === acc.user);
        if (pf) pf.failed++;
        console.error(
          JSON.stringify({
            level: "error",
            event: "send_batch_fail",
            reqId,
            idx: i,
            sender: acc.user,
            to: msg.to,
            reason,
            code: out.error?.responseCode,
          })
        );
        return { ok: false, to: msg.to, error: reason };
      }
    })
  );

  const summary = {
    reqId,
    total: messages.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    perAccount: perAccountStats,
    failures: results
      .map((r, i) =>
        !r.ok ? { index: i, to: messages[i].to, error: r.error } : null
      )
      .filter(Boolean),
  };

  // Per your requirements, provide per-account usage and any limits hit
  console.log(
    JSON.stringify({ level: "info", event: "batch_summary", reqId, summary })
  );

  return res.status(200).json({ message: "Batch processed", summary, results });
}
