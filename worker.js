// Cloudflare Worker — proxy para AnimeSchedule API
// Despliegue:
//   1. Ve a https://workers.cloudflare.com y crea una cuenta gratuita
//   2. Crea un nuevo Worker, pega este código y haz clic en "Deploy"
//   3. Copia la URL que te asignen (ej. https://anime-proxy.TU-USUARIO.workers.dev)
//   4. Pégala en el campo "URL del proxy" dentro de los Ajustes de la app

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const incoming = new URL(request.url);
    const target = new URL("https://animeschedule.net/api/v3/timetables");
    for (const [k, v] of incoming.searchParams) target.searchParams.set(k, v);

    const rawToken = incoming.searchParams.get("api_token") || "";
    const authHeader = rawToken
      ? (rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`)
      : "";

    try {
      const res = await fetch(target, {
        headers: {
          accept: "application/json",
          ...(authHeader && { authorization: authHeader }),
        },
      });
      const body = await res.arrayBuffer();
      return new Response(body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};
