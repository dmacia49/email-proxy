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

// ===== Sender pool (using your hardcoded fallbacks) =====
const SENDER_POOL = [
  {
    label: "PRIMARY",
    user: "allstatebm2@gmail.com",
    pass: process.env.GMAIL2_PASS || "akyswfsarantchxt",
  },
  {
    label: "BACKUP_A",
    user: "allstatebm@gmail.com",
    pass: process.env.GMAIL1_PASS || "bayuwsrqoiofgrbr",
  },
  {
    label: "BACKUP_B",
    user: "allstatebm3@gmail.com",
    pass: process.env.GMAIL3_PASS || "iexvbzmwueoxdllr",
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
        // Gentle, safe defaults; override via env if desired
        maxConnections: Number(process.env.SMTP_MAX_CONN || 1),
        maxMessages: Number(process.env.SMTP_MAX_MSG || 100),
        rateDelta: Number(process.env.SMTP_RATE_DELTA || 1200), // ms window
        rateLimit: Number(process.env.SMTP_RATE_LIMIT || 1), // msgs per window
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
  // rough: 3/4 of chars (ignores padding)
  return Math.floor((b64 || "").length * 0.75);
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

// ===== Simple round-robin across accounts (per instance) =====
let rrIndex = 0;
function accountsInOrder() {
  const n = SENDER_POOL.length;
  if (n === 0) return [];
  const start = rrIndex++ % n;
  const ordered = Array.from(
    { length: n },
    (_, i) => SENDER_POOL[(start + i) % n]
  );
  return ordered;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (!ORIGINS.has(origin))
    return res.status(403).json({ error: "Forbidden origin" });
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-ABM-Key, X-Request-Id"
  );

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

  const reqId = req.headers["x-request-id"] || crypto.randomUUID();

  // Parse body
  const { subject, body, pdf, to, filename, attachmentUrl } = req.body || {};
  console.log(
    JSON.stringify({
      level: "info",
      event: "incoming",
      reqId,
      to,
      subject: (subject || "").slice(0, 120),
      hasPdf: Boolean(pdf),
      hasUrl: Boolean(attachmentUrl),
    })
  );

  // Validate
  if (!subject || !body || !to || (!pdf && !attachmentUrl)) {
    return res.status(400).json({
      error:
        "Missing required fields (subject, body, to, and pdf OR attachmentUrl)",
      reqId,
    });
  }
  if (!isValidEmail(to)) {
    return res.status(400).json({ error: "Invalid recipient email", reqId });
  }
  if (
    pdf &&
    b64ApproxBytes(pdf) >
      Number(process.env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024)
  ) {
    return res.status(413).json({ error: "Attachment too large", reqId });
  }
  if (!SENDER_POOL.length) {
    return res
      .status(500)
      .json({ error: "No sender accounts configured", reqId });
  }

  const mailBase = {
    to,
    subject,
    text: body,
    from: undefined, // set per account
    replyTo: "no-reply@allstatebm.com",
    headers: {
      "List-Unsubscribe":
        "<mailto:no-reply@allstatebm.com?subject=unsubscribe>",
      "X-Request-Id": reqId,
    },
    attachments: [
      {
        filename: filename || "invoice.pdf",
        ...(attachmentUrl
          ? { path: attachmentUrl }
          : { content: Buffer.from(pdf, "base64") }),
        contentType: "application/pdf",
        contentDisposition: "attachment",
      },
    ],
  };

  let lastError = null;

  // Try accounts in round-robin order; retry once on transient failure for the chosen account,
  // switch to next account on daily-limit or persistent/transient failures.
  for (const acc of accountsInOrder()) {
    try {
      const transporter = getTransporter(acc.user, acc.pass);
      const mailOptions = {
        ...mailBase,
        from: `Allstate Billing <${acc.user}>`,
      };

      // First attempt
      try {
        const info = await transporter.sendMail(mailOptions);
        console.log(
          JSON.stringify({
            level: "info",
            event: "sent",
            reqId,
            sender: acc.user,
            to,
            messageId: info.messageId,
          })
        );
        return res.status(200).json({
          message: "Email sent",
          recipient: to,
          sender: acc.user,
          id: info.messageId,
          reqId,
        });
      } catch (err1) {
        const c1 = classify(err1);
        console.error(
          JSON.stringify({
            level: "error",
            event: "send_fail_first",
            reqId,
            account: acc.label,
            sender: acc.user,
            to,
            reason: c1.reason,
            code: err1?.responseCode,
          })
        );
        lastError = err1;

        // If daily limit exceeded, immediately try next account
        if (/Daily user sending limit exceeded/i.test(err1?.message || "")) {
          continue;
        }

        // Retry once on retryable errors (same account)
        if (c1.retryable) {
          await sleep(800);
          try {
            const info2 = await transporter.sendMail(mailOptions);
            console.log(
              JSON.stringify({
                level: "info",
                event: "sent_after_retry",
                reqId,
                sender: acc.user,
                to,
                messageId: info2.messageId,
              })
            );
            return res.status(200).json({
              message: "Email sent",
              recipient: to,
              sender: acc.user,
              id: info2.messageId,
              reqId,
            });
          } catch (err2) {
            const c2 = classify(err2);
            console.error(
              JSON.stringify({
                level: "error",
                event: "send_fail_retry",
                reqId,
                account: acc.label,
                sender: acc.user,
                to,
                reason: c2.reason,
                code: err2?.responseCode,
              })
            );
            lastError = err2;
            // Move to next account
            continue;
          }
        }

        // Non-retryable error (not daily-limit) -> return 502 now
        return res
          .status(502)
          .json({ error: "Send failed", detail: c1.reason, reqId });
      }
    } catch (outer) {
      // Transporter creation or unexpected error
      lastError = outer;
      console.error(
        JSON.stringify({
          level: "error",
          event: "transporter_error",
          reqId,
          account: acc.label,
          sender: acc.user,
          to,
          reason: outer?.message || "unknown",
        })
      );
      // try next account
      continue;
    }
  }

  return res.status(500).json({
    error: "Failed to send email on all accounts",
    detail: lastError?.message || "Unknown error",
    reqId,
  });
}
