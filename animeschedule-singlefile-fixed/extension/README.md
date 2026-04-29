# Anime Countdown Fixed


## Versión 4.0.2

- Corrige el 404 de AnimeSchedule.
- Para semanas futuras usa `/timetables?year=YYYY&week=WW&tz=...`.
- Luego filtra SUB dentro de la extensión.
- Si una semana futura devuelve 404, se salta esa semana en vez de romper toda la importación.


## Versión 4.1

Nuevo modelo:
- AnimeSchedule se usa para confirmar plataforma y hora real de estreno cercana.
- AniList se usa para detectar si hay próximo episodio.
- Si AniList confirma próximo episodio y AnimeSchedule aún no lo tiene:
  - se crea un episodio inferido;
  - se usa la misma hora/día semanal del último episodio confirmado por AnimeSchedule;
  - aparece en la interfaz automáticamente.
- Si no hay episodio base de AnimeSchedule, usa el contador de AniList como fallback, pero al abrir pedirá asociar plataforma/link.
- Por defecto AnimeSchedule importa 2 semanas, no 12, porque el futuro lejano lo decide AniList.
