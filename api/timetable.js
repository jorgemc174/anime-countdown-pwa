// Vercel serverless function — proxy para AnimeSchedule API
// Al estar en el mismo dominio que la app, el navegador no necesita CORS.
// Se despliega automáticamente cuando subes el proyecto a Vercel.
module.exports = async (req, res) => {
  const { api_token, ...rest } = req.query;
  const rawToken = Array.isArray(api_token) ? api_token[0] : api_token;

  // Try both auth methods: Bearer header + api_token query param
  const params = new URLSearchParams({
    ...rest,
    ...(rawToken && { api_token: rawToken }),
  }).toString();
  const upstream = `https://animeschedule.net/api/v3/timetables?${params}`;
  const authorization = rawToken
    ? (rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`)
    : "";

  try {
    const r = await fetch(upstream, {
      headers: {
        accept: "application/json, */*",
        "accept-language": "es-ES,es;q=0.9,en;q=0.8",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        referer: "https://animeschedule.net/",
        origin: "https://animeschedule.net",
        ...(authorization && { authorization }),
      },
    });
    const body = await r.text();
    res
      .status(r.status)
      .setHeader("content-type", r.headers.get("content-type") || "application/json; charset=utf-8")
      .send(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
