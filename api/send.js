export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST requests allowed");
  }

  const { email, subject, body, pdf } = req.body;

  if (!email || !subject || !body || !pdf) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const scriptUrl =
      "https://script.google.com/macros/s/AKfycby6t_h8z_ywaFWL129sSUDkbO3CFyx2lZdBNiEtUqCmnnznKuHxYqpo73I8G50WgPOIpg/exec"; // 🔁 Replace this
    const params = new URLSearchParams({ email, subject, body, pdf });

    const response = await fetch(`${scriptUrl}?${params.toString()}`, {
      method: "GET", // GAS doesn't support POST from browser unless CORS is enabled
    });

    const text = await response.text();
    res.status(200).json({ message: text });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to send email", details: error.toString() });
  }
}
