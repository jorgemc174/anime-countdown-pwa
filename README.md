# Anime Countdown PWA

## Desarrollo y comprobaciones

Requiere Node.js 24. El checkout existente es suficiente.

```sh
npm ci
npm run dev
npm test
npx playwright install chromium
npm run test:browser
npm run build:www
npm run cap:sync
```

Las pruebas de navegador pueden usar un Chromium ya instalado mediante
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. El empaquetado `build:www` funciona en
Windows y Linux y copia exclusivamente los recursos públicos, sin servidor,
dependencias, pruebas ni scripts de mantenimiento. Para compilar el APK con el
Gradle actual hacen falta JDK 17 y Android SDK 34; después de `cap:sync`, ejecutar
`bash android/gradlew -p android assembleDebug` (Windows: `gradlew.bat`).

## Base compartida de horarios y plataformas

El usuario solo sincroniza su biblioteca de AniList. No prepara horarios ni hace
consultas a JustWatch desde su navegador o Android. La app descarga automáticamente
la base compartida al arrancar y cada quince minutos mientras está visible.
La sincronización de AniList marca sus series y mantiene sus preferencias locales;
no sube usuarios ni favoritos al catálogo compartido. Incluye series en seguimiento
que estén retrasadas aunque AniList no tenga un próximo episodio fechado.

Cada tres horas, `Update anime schedule` prepara y publica en una sola ejecución:

1. Los horarios SUB de AnimeSchedule, metadatos y seguimiento de retrasos.
2. Las plataformas regionales de JustWatch mediante `npm run sync:platforms`.
3. El `schedule.json` enriquecido y la caché reutilizable `platform-cache.json`.

El catálogo incluye los doce países del selector, con España por defecto.
`JUSTWATCH_COUNTRIES=ES,MX` permite limitar la generación si se desea. Cada episodio
incluye `basePlatforms` (fuente original) y `platformsByCountry` con ofertas,
fecha de comprobación y estado por país. Cambiar de país selecciona esos datos
localmente; solo se muestran las ofertas de JustWatch del país seleccionado.
Las plataformas globales de AniList y AnimeSchedule se conservan como metadatos
internos, pero no se usan como alternativa cuando falta disponibilidad local.

Las consultas se agrupan por serie y país, se reutilizan durante doce horas y se
limitan a tres simultáneas y cuatro minutos por ejecución. Los pendientes continúan
en los próximos cron. Un límite 429 detiene nuevas consultas hasta otra ejecución.
Se conservan las últimas ofertas conocidas del mismo país ante fallos. Un
resultado sin coincidencia, pendiente o sin ofertas deja la serie sin plataforma
indicada; eso no prueba que no exista una opción legal. Nunca se utiliza una
plataforma de Estados Unidos como alternativa para España u otro país. Las plataformas son disponibilidad de
la serie, no una garantía de cada temporada o episodio.

Se excluyen alquileres y compras; los canales adicionales son suscripciones
separadas. Se comprueban también series que ya tengan Crunchyroll. Las plataformas
no cambian fechas, episodios ni horas SUB. No se requiere un token de JustWatch.
El resumen del workflow muestra la cobertura y los pendientes por país.

Para reproducir el enriquecimiento del catálogo ya generado:

```sh
npm run sync:platforms
```

## Horarios SUB y retrasos

- «Hoy» muestra únicamente favoritos. «Todos» permite descubrir y añadir series.
- La web consulta su `schedule.json`; Android consulta
  `https://anicountdown.com/schedule.json`, configurable con `REMOTE_SCHEDULE_URL`.
  Los datos y favoritos se conservan localmente. En el primer arranque de Android
  sin conexión se usa el horario empaquetado, indicando si está caducado.
- AnimeSchedule determina la **hora SUB**. AniList aporta metadatos y enlaces
  oficiales; su horario japonés no crea ni modifica estrenos SUB.
- Los retrasos sin confirmación se muestran separados, sin cuenta atrás ni
  notificación. Una fecha SUB oficial sin hora actualizada de AnimeSchedule se
  muestra como «Hora SUB por confirmar». Las contradicciones siguen pendientes.
- `delay-tracking.json` conserva episodios pendientes fuera de la ventana del
  calendario. El workflow los revisa cada tres horas, también cuando falla la
  generación del horario. Guarda fuentes, evidencia, errores y última consulta.
  Las cancelaciones oficiales detienen el seguimiento.
- La búsqueda descubre enlaces «Official Site» en AniList con coincidencia fuerte
  de serie y comprueba la web oficial y hasta dos enlaces de noticias/episodios
  del mismo dominio. Solo acepta anuncios inequívocos del episodio y de SUB:
  eventos JSON-LD con `subtitleLanguage`, o párrafos de reprogramación que indiquen
  explícitamente SUB, episodio y una única fecha completa. Conserva la URL y la
  cita cuando procede. Las fechas de publicación de artículos no son estrenos.
- No se interpretan automáticamente imágenes, vídeos, páginas con acceso
  restringido ni comunicados ambiguos. Estos casos permanecen pendientes y se
  vuelven a consultar; no se inventa una fecha. Cada ejecución limita las
  consultas y rota los pendientes por antigüedad para respetar el tiempo del job.
- Las notificaciones web requieren la app abierta; no hay servicio push.
  Android programa hasta siete días confirmados y cancela avisos de fechas
  anteriores o episodios que vuelvan a quedar pendientes.

## Recuperar una agenda caducada en producción

El workflow `Update anime schedule` debe estar activo: GitHub puede desactivar los
cron de repositorios públicos por inactividad. Tras publicar los cambios del
generador, ejecutar el workflow manualmente y comprobar su resumen y
`https://anicountdown.com/schedule.json`. Verificar que contiene emisiones SUB
futuras y que el despliegue de Vercel corresponde al commit actualizado. Un job
verde antiguo no garantiza datos vigentes.

Las semanas futuras con 404 son normales y no deben impedir publicar las semanas
disponibles. La ausencia de datos válidos o un token rechazado hacen fallar el
job sin reemplazar el último horario. Si no hay emisiones futuras confirmadas,
el resumen del workflow también falla. `updatedAt` indica cambios en los datos;
`checkedAt` indica la última generación satisfactoria.

La comprobación del 30 de octubre de 2026 encontró el workflow desactivado y el
horario publicado del 22 de julio. Se reactivó y ejecutó: respondió correctamente
AnimeSchedule para cinco semanas, pero el generador anterior exigía siete y
conservó el archivo caducado. Este criterio está corregido en el código actual.
La ejecución con código nuevo y el despliegue siguen siendo necesarios para
recuperar los datos publicados; no hace falta sustituir el token salvo que el
workflow indique rechazo de autenticación.

Las peticiones autenticadas usan cabeceras y el backend propio, nunca proxies
públicos ni tokens en URLs. `vercel.json` permite la lectura pública del horario
desde Android y desactiva la caché de las APIs.

## Horario compartido gratis

La PWA lee `schedule.json`, un archivo compartido que GitHub Actions puede actualizar automaticamente con tu token de AnimeSchedule guardado como secreto.

1. Sube el proyecto a GitHub.
2. En Settings > Secrets and variables > Actions, crea `ANIMESCHEDULE_TOKEN`.
3. Activa Actions en el repositorio.
4. Ejecuta manualmente `Update anime schedule` o espera al cron de cada 3 horas.
5. Publica la PWA con GitHub Pages, Vercel, Netlify o Cloudflare Pages.

El token no se publica en la app. Solo se guarda el resultado ya normalizado en `schedule.json`.

El generador usa AnimeSchedule como fuente principal de horarios SUB. AniList completa metadatos y enlaces oficiales. JustWatch añade plataformas regionales en el proceso automático. AniList no crea ni modifica fechas de estreno SUB.

Versión web instalable en móvil de la extensión.

## Qué mantiene

- AnimeSchedule para horarios SUB y plataforma cuando exista la serie.
- AniList para metadatos, notas y favoritos.
- JustWatch para plataformas regionales ya preparadas en la base compartida.
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
