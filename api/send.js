// /api/send.js
import nodemailer from "nodemailer";

export default async function handler(req, res) {
  // ✅ Handle CORS
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://allstatebm.kintone.com"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  // ✅ Parse body
  const { subject, body, pdf, to } = req.body || {};
  console.log("[Server] Incoming request:", { subject, to });

  // ✅ Validate
  if (!subject || !body || !pdf || !to) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // ✅ Sender pool (rotates if daily limit hit or failure)
  const SENDER_POOL = [
    {
      label: "PRIMARY",
      user: "allstatebm3@gmail.com",
      pass: process.env.GMAIL3_PASS || "iexvbzmwueoxdllr",
    },
    {
      label: "BACKUP_A",
      user: "allstatebm2@gmail.com",
      pass: process.env.GMAIL2_PASS || "akyswfsarantchxt",
    },
    {
      label: "BACKUP_B",
      user: "allstatebm@gmail.com",
      pass: process.env.GMAIL1_PASS || "bayuwsrqoiofgrbr",
    },
  ];

  let lastError = null;

  for (const acc of SENDER_POOL) {
    if (!acc?.user || !acc?.pass) continue;

    try {
      // ✅ Create transporter for this account
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: acc.user, pass: acc.pass },
      });

      // ✅ Per-account mail options
      const mailOptions = {
        from: `Allstate Billing <${acc.user}>`,
        replyTo: acc.user, // reply goes to same sender account
        to,
        subject,
        text: body,
        attachments: [
          {
            filename: "invoice.pdf",
            content: Buffer.from(pdf, "base64"),
            contentType: "application/pdf",
          },
        ],
      };

      // ✅ Attempt send
      const info = await transporter.sendMail(mailOptions);
      console.log(
        `[Server] Email sent via ${acc.label}: ${acc.user} -> ${to}, Message ID: ${info.messageId}`
      );

      return res.status(200).json({
        message: "Email sent",
        recipient: to,
        sender: acc.user,
        id: info.messageId,
      });
    } catch (err) {
      lastError = err;
      console.error(
        `[Server] Send failed via ${acc.label}:`,
        err?.message || err
      );
      // If daily limit or quota, try next account
      if (/Daily user sending limit exceeded/i.test(err?.message || ""))
        continue;
      break; // other errors → stop
    }
  }

  return res.status(500).json({
    error: "Failed to send email",
    detail: lastError?.message || "Unknown error",
  });
}
