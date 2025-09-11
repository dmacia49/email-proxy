// /api/send.js

import nodemailer from "nodemailer";

export default async function handler(req, res) {
  // ✅ Handle CORS
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://allstatebm3.kintone.com"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ✅ Include `to` (recipient) in the request body
  const { subject, body, pdf, to } = req.body;

  console.log("[Server] Incoming request:", { subject, to });

  // ✅ Validate all required fields including `to`
  if (!subject || !body || !pdf || !to) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // ✅ Gmail + App Password auth
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "allstatebm3@gmail.com",
        pass: "iexvbzmwueoxdllr",
      },
    });

    // ✅ Dynamic recipient
    const mailOptions = {
      from: "Allstate Billing <allstatebm3@gmail.com>",
      to, // recipient from the request body
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
