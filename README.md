# Anime Countdown PWA

## Horario compartido gratis

La PWA lee `schedule.json`, un archivo compartido que GitHub Actions puede actualizar automaticamente con tu token de AnimeSchedule guardado como secreto.

1. Sube el proyecto a GitHub.
2. En Settings > Secrets and variables > Actions, crea `ANIMESCHEDULE_TOKEN`.
3. Activa Actions en el repositorio.
4. Ejecuta manualmente `Update anime schedule` o espera al cron de cada 3 horas.
5. Publica la PWA con GitHub Pages, Vercel, Netlify o Cloudflare Pages.

El token no se publica en la app. Solo se guarda el resultado ya normalizado en `schedule.json`.

El generador usa AnimeSchedule como fuente principal de horarios SUB. AniList completa metadatos y tambien puede añadir animes que no existan en AnimeSchedule dentro de la ventana configurada, marcados como `anilist-missing`, sin pisar los horarios de AnimeSchedule.

Versión web instalable en móvil de la extensión.

## Qué mantiene

- AnimeSchedule para horarios SUB y plataforma cuando exista la serie.
- AniList para metadatos, notas, favoritos y animes ausentes de AnimeSchedule.
- Favoritos.
- Links/plataformas personalizados por serie.
- Cuenta atrás con segundos.
- Datos guardados localmente en el navegador.

## Cómo instalar en móvil

Necesitas subir la carpeta a un hosting HTTPS.

Opciones fáciles:
- Netlify Drop
- Vercel
- GitHub Pages
- Cloudflare Pages

### Android Chrome

1. Abre la URL de la web.
2. Menú de Chrome.
3. Instalar app o Añadir a pantalla de inicio.

### iPhone Safari

1. Abre la URL en Safari.
2. Compartir.
3. Añadir a pantalla de inicio.

## Importante

Al ser web normal, no tiene permisos especiales de extensión.
Si AnimeSchedule bloquea peticiones CORS desde navegador, hará falta un proxy/backend pequeño.
AniList normalmente sí funciona desde navegador.
