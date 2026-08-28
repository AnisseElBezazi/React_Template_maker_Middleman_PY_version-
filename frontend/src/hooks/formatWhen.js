/** Formate un run_id (horodatage-suffixe) ou une date ISO en date lisible.
 * Les identifiants de run commencent par un horodatage en millisecondes. */
export function formatWhen(value) {
  if (!value) return "";
  const ms = /^\d{13}-/.test(value) ? parseInt(value.slice(0, 13), 10) : Date.parse(value);
  if (!ms) return value;
  return new Date(ms).toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
