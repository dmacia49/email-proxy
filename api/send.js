export default async function handler(req, res) {
  // ✅ Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  // ✅ Main CORS header
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Only POST allowed" });
  }

  const { email, subject, body, pdf } = req.body;

  try {
    const gmailResponse = await fetch(
      "https://script.google.com/macros/s/AKfycby6t_h8z_ywaFWL129sSUDkbO3CFyx2lZdBNiEtUqCmnnznKuHxYqpo73I8G50WgPOIpg/exec",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, subject, body, pdf }),
      }
    );

    const result = await gmailResponse.text();
    res.status(200).json({ message: result });
  } catch (error) {
    console.error("Send failed:", error);
    res.status(500).json({ message: "Failed to send email" });
  }
}
