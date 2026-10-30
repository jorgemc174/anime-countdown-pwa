(function (root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  else root.SchedulePolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const PENDING = new Set(["pending", "date-confirmed", "conflict"]);
  function isPending(item) { return PENDING.has(item.scheduleStatus); }
  function hasConfirmedTime(item) {
    return !isPending(item) && item.scheduleStatus !== "cancelled" &&
      typeof item.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(item.releaseDate) && Number.isFinite(Date.parse(item.releaseDate));
  }
  function episodeKey(item) {
    return `${item.animeKey || item.anime_key || item.route || item.anilistId || item.title}|${item.episodeNumber ?? item.episode_number ?? item.episode}`;
  }
  function health(payload, now = Date.now()) {
    const rows = Array.isArray(payload) ? payload : payload?.releases;
    if (!Array.isArray(rows)) throw new Error("El horario no contiene una lista de episodios válida.");
    const future = rows.filter(item => hasConfirmedTime(item) && Date.parse(item.releaseDate) >= now).length;
    const pending = rows.filter(isPending).length;
    return { future, pending, stale: future === 0, updatedAt: payload?.updatedAt || "", checkedAt: payload?.checkedAt || "" };
  }
  function validate(payload) {
    const rows = Array.isArray(payload) ? payload : payload?.releases;
    if (!Array.isArray(rows)) throw new Error("El horario no contiene una lista de episodios válida.");
    if (rows.some(row => !row || typeof row !== "object" || typeof row.title !== "string" || !row.title.trim() ||
      (!isPending(row) && row.scheduleStatus !== "cancelled" && !hasConfirmedTime(row)))) {
      throw new Error("El horario contiene episodios sin título o con fechas inválidas.");
    }
    return rows;
  }
  return { isPending, hasConfirmedTime, episodeKey, health, validate };
});
