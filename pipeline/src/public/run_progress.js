// Suivi d'un run en cours : interroge status.json, met à jour les étapes et le
// flux de sortie du modèle. Les valeurs propres au run arrivent par
// window.CV_RUN, posé juste avant ce fichier.
const CV = window.CV_RUN;

const STAGE_IDS = CV.stageIds;
        const STAGE_NAMES = CV.stageNames;
        const startedAt = CV.startedAt;

        function tickElapsed() {
          const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
          const el = document.getElementById('elapsed');
          if (el) el.textContent = Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
        }
        setInterval(tickElapsed, 1000); tickElapsed();

        // Le rail d'étapes est rendu par le serveur au premier chargement ;
        // ensuite on ne repositionne que le curseur, sans reconstruire le DOM
        // (sinon l'anneau de l'étape active repart de zéro à chaque sondage).
        function paintStages(step, message) {
          const known = STAGE_IDS.indexOf(step);
          const idx = step === 'done' ? STAGE_IDS.length : (known === -1 ? 0 : known);
          document.querySelectorAll('.stage').forEach((li, i) => {
            li.classList.toggle('past', i < idx);
            li.classList.toggle('now', i === idx);
            const dot = li.querySelector('.stage-dot');
            if (dot) dot.textContent = i < idx ? '\\u2713' : String(i + 1);
            if (i === idx && message) li.querySelector('.stage-note').textContent = message;
          });
        }

        async function poll() {
          let s;
          try {
            const r = await fetch('/runs/' + CV.runId + '/status.json');
            s = await r.json();
          } catch { setTimeout(poll, 2000); return; }

          paintStages(s.step, s.message);
          const log = document.getElementById('logbox');
          const logAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
          log.textContent = s.log.map(l => '[' + l.step + '] ' + l.message).join('\\n');
          if (logAtBottom) log.scrollTop = log.scrollHeight;

          if (s.stream && s.stream.text) {
            const wrap = document.getElementById('streambox-wrap');
            const box = document.getElementById('streambox');
            const label = document.getElementById('streambox-label');
            const icon = document.getElementById('streambox-icon');
            wrap.hidden = false;
            const thinking = s.stream.kind === 'thinking';
            icon.innerHTML = thinking ? CV.iconThink : CV.iconWrite;
            label.textContent = (thinking ? 'Réflexion' : 'Écriture') + ' — ' + (STAGE_NAMES[s.stream.step] || s.stream.step);
            // On ne recolle en bas que si l'utilisateur y était déjà : sinon
            // relire un passage plus haut devient impossible.
            const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
            box.textContent = s.stream.text;
            if (wasAtBottom) box.scrollTop = box.scrollHeight;
          }
          if (s.status === 'done' || s.status === 'error') { location.reload(); return; }
          setTimeout(poll, 1000);
        }
        poll();
