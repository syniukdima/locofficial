export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Try both with and without VITE_ prefix (Vercel compatibility)
    const clientId = process.env.VITE_DISCORD_CLIENT_ID;
    const clientSecret = process.env.VITE_DISCORD_CLIENT_SECRET;
    const body = typeof req.body === "string" ? safeJsonParse(req.body) : req.body;
    const code = body?.code;

    if (!clientId || !clientSecret) {
      console.error('Missing env vars:', { 
        hasClientId: !!clientId, 
        hasSecret: !!clientSecret,
        availableKeys: Object.keys(process.env).filter(k => k.includes('DISCORD'))
      });
      return res.status(500).json({ 
        error: "Missing Discord client credentials",
        debug: {
          hasClientId: !!clientId,
          hasSecret: !!clientSecret
        }
      });
    }
    if (!code) {
      return res.status(400).json({ error: "Missing authorization code" });
    }

    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: "Discord token exchange failed", details: text });
    }

    const { access_token } = await response.json();
    return res.status(200).json({ access_token });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}


