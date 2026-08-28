// Rail de gauche : l'historique des runs. Reçoit la liste déjà préparée par
// le service, il ne va pas la chercher lui-même.

import { ICON } from "./icons_view.mjs";

export function runsRail(entries, currentId = null) {
  const past = entries.slice(0, currentId ? 6 : 14);
  return `<div class="rail-group">
    <p class="rail-title">${ICON.layers} Runs</p>
    ${past.length
      ? `<ul class="runlist">${past.map((run, i) => `<li>
          <a href="/runs/${run.id}"${run.id === currentId ? ' aria-current="page"' : ""}>
            <span class="when">${run.when}</span>${i === 0 ? `<span class="tag">dernier</span>` : ""}
            <span class="rid">${run.id}</span>
          </a>
        </li>`).join("")}</ul>`
      : `<p style="padding:0 12px;font-size:11.5px;color:var(--tx-3);margin:0">Aucun run pour l'instant. Le premier apparaîtra ici.</p>`}
  </div>`;
}
