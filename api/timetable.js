// Vercel serverless function — proxy para AnimeSchedule API
// Al estar en el mismo dominio que la app, el navegador no necesita CORS.
// Se despliega automáticamente cuando subes el proyecto a Vercel.
module.exports = async (req, res) => {
  const params = new URLSearchParams(req.query).toString();
  const upstream = `https://animeschedule.net/api/v3/timetables?${params}`;

  try {
    const r = await fetch(upstream, { headers: { accept: "application/json" } });
    const body = await r.text();
    res
      .status(r.status)
      .setHeader("content-type", r.headers.get("content-type") || "application/json; charset=utf-8")
      .send(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
