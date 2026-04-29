// Vercel serverless function — proxy para AnimeSchedule API
// Al estar en el mismo dominio que la app, el navegador no necesita CORS.
// Se despliega automáticamente cuando subes el proyecto a Vercel.
module.exports = async (req, res) => {
  const { api_token, ...rest } = req.query;
  const params = new URLSearchParams(rest).toString();
  const upstream = `https://animeschedule.net/api/v3/timetables?${params}`;

  const token = Array.isArray(api_token) ? api_token[0] : api_token;
  const authorization = token
    ? (token.startsWith("Bearer ") ? token : `Bearer ${token}`)
    : "";

  try {
    const r = await fetch(upstream, {
      headers: {
        accept: "application/json",
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
