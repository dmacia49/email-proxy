// /api/send.js
import nodemailer from "nodemailer";

export default async function handler(req, res) {
  // ✅ Allow CORS only from your Kintone domain
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://allstatebm.kintone.com"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ✅ Handle preflight request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { subject, body, pdf } = req.body;

  console.log("[Server] Incoming request:", { subject });

  if (!subject || !body || !pdf) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Create transport using Gmail + App Password
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "allstatebm@gmail.com",
        pass: "pjnffmqzrgvhcmks", // Replace with actual 16-char App Password
      },
    });

    const mailOptions = {
      from: `Allstate Billing <allstatebm@gmail.com>`,
      to: "danielmacias1991@gmail.com",
      subject: subject,
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
    console.log("[Server] Email sent:", info.messageId);

    return res.status(200).json({ message: "Email sent" });
  } catch (error) {
    console.error("[Server] Email error:", error);
    return res.status(500).json({ error: "Failed to send email" });
  }
}
