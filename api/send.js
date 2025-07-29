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

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ✅ Include `to` (recipient)
  const { subject, body, pdf, to } = req.body;

  console.log("[Server] Incoming request:", { subject, to });

  if (!subject || !body || !pdf || !to) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "allstatebm@gmail.com",
        pass: "bayuwsrqoiofgrbr",
      },
    });

    const mailOptions = {
      from: "Allstate Billing <allstatebm@gmail.com>",
      to, // dynamic recipient
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

    const info = await transporter.sendMail(mailOptions);
    console.log("[Server] Email sent to:", to, "Message ID:", info.messageId);

    return res.status(200).json({ message: "Email sent", recipient: to });
  } catch (error) {
    console.error("[Server] Email error:", error);
    return res.status(500).json({ error: "Failed to send email" });
  }
}
