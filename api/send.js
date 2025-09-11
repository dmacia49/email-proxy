// /api/send.js

import nodemailer from "nodemailer";

export const config = {
  api: { bodyParser: { sizeLimit: "25mb" } }, // handle base64 PDFs comfortably
};

// Sender pool: primary then backup
const SENDER_POOL = [
  {
    label: "PRIMARY",
    user: "allstatebm3@gmail.com",
    pass: process.env.GMAIL3_PASS || "iexvbzmwueoxdllr", // App Password (env preferred)
  },
  {
    label: "BACKUP_A",
    user: "allstatebm2@gmail.com",
    pass: process.env.GMAIL2_PASS || "akyswfsarantchxt", // set in Vercel env
  },
  {
    label: "BACKUP_B",
    user: "allstatebm@gmail.com",
    pass: process.env.GMAIL1_PASS || "bayuwsrqoiofgrbr", // App Password (env preferred)
  },
];

function makeTransport({ user, pass }) {
  // Gmail with App Password (2FA-enabled accounts)
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

function isDailyLimitError(err) {
  const s = `${err?.message || ""} ${err?.response || ""} ${
    err?.responseCode || ""
  }`;
  return /5\.4\.5/i.test(s) || /Daily user sending limit exceeded/i.test(s);
}

export default async function handler(req, res) {
  // CORS
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://allstatebm.kintone.com"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { subject, body, pdf, to, filename } = req.body || {};
    if (!subject || !body || !pdf || !to) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // base options common to all senders (NO replyTo here)
    const mailBase = {
      to,
      subject,
      text: body,
      attachments: [
        {
          filename: filename || "invoice.pdf",
          content: Buffer.from(pdf, "base64"),
          contentType: "application/pdf",
        },
      ],
    };

    let lastErr = null;

    for (const acc of SENDER_POOL) {
      if (!acc?.user || !acc?.pass) continue; // skip unconfigured account

      const transporter = makeTransport(acc);
      const mailOptions = {
        ...mailBase,
        from: `Allstate Billing <${acc.user}>`,
        // 👇 Reply-To now matches the actual sender account used
        replyTo: `Allstate Billing <${acc.user}>`,
      };

      try {
        const info = await transporter.sendMail(mailOptions);
        console.log(
          "[Server] Email sent via:",
          acc.label,
          "to:",
          to,
          "Message ID:",
          info.messageId
        );
        return res.status(200).json({
          message: "Email sent",
          recipient: to,
          sender: acc.user,
          id: info.messageId,
        });
      } catch (error) {
        lastErr = error;
        console.error(
          `[Server] Send failed via ${acc.label}:`,
          error?.response || error?.message || error
        );
        if (isDailyLimitError(error)) continue; // try next account on daily-limit
        break; // other errors: stop and surface
      }
    }

    return res.status(500).json({
      error: "Failed to send email",
      detail: String(
        lastErr?.response || lastErr?.message || lastErr || "Unknown error"
      ),
    });
  } catch (e) {
    console.error("[Server] Email error:", e);
    return res
      .status(500)
      .json({ error: "Failed to send email", detail: String(e?.message || e) });
  }
}
