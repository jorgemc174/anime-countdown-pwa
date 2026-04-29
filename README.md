# Anime Countdown PWA

Versión web instalable en móvil de la extensión.

## Qué mantiene

- AnimeSchedule para confirmar plataforma y hora cercana.
- AniList para detectar próximos capítulos.
- Episodios inferidos cuando AniList confirma siguiente capítulo.
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
