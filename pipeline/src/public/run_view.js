// Plan de travail de la page de run : zoom, panoramique, outils, calque de
// décalque et barre d'édition. Les valeurs qui dépendent du run arrivent par
// window.CV_RUN, posé juste avant ce fichier.
const CV = window.CV_RUN;

// ======================= Plan de travail pan/zoom =======================
      // Les deux pages vivent côte à côte à leur taille réelle (voir CV.W / CV.H)
      // dans un monde qu'on translate et met à l'échelle d'un bloc. Comparer
      // deux rendus suppose de pouvoir cadrer librement : voir les deux pages
      // entières, puis plonger au pixel sur un détail sans perdre l'autre.
      const vp = document.getElementById('viewport');
      const world = document.getElementById('world');
      const WORLD_W = CV.worldW, WORLD_H = CV.worldH;
      // La barre du bas flotte au-dessus du plan de travail : le cadrage lui
      // réserve sa hauteur, sinon elle masque le pied des pages.
      const MAX_Z = 8, FIT_PAD = 56, DOCK_SAFE = 52;
      // Le plan de travail est borné : au-delà des pages, on ne peut découvrir
      // qu'une marge de vide, jamais les perdre de vue. Sans ça un glisser un
      // peu vif laisse un écran gris, et il faut retrouver son chemin à
      // l'aveugle. La marge est proportionnelle à la fenêtre pour rester
      // franchissable au zoom fort comme au zoom faible.
      const OVERSCROLL = 0.3;
      let z = 1, tx = 0, ty = 0, spaceDown = false;

      const zVal = document.getElementById('zVal');
      const frameNames = () => document.querySelectorAll('.frame-name');

      /** Échelle à laquelle les deux pages tiennent entièrement à l'écran. */
      function fitZoom(pad) {
        pad = pad == null ? FIT_PAD : pad;
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return 1;
        return Math.max(0.02, Math.min((r.width - pad * 2) / WORLD_W, (r.height - DOCK_SAFE - pad * 2) / WORLD_H));
      }
      // Dézoomer au-delà de la moitié du cadrage complet ne montre plus rien
      // d'utile : c'est la borne basse.
      function clampZ(v) { return Math.max(fitZoom() * 0.5, Math.min(MAX_Z, v)); }

      /** Ramène le déplacement dans les bornes du plan de travail. */
      function clampPan() {
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const m = Math.min(r.width, r.height) * OVERSCROLL;
        // Les deux bornes se croisent selon que les pages sont plus larges ou
        // plus étroites que la fenêtre ; min/max remet l'intervalle à
        // l'endroit dans les deux cas. Le cadrage complet, lui, tombe toujours
        // dedans -- il n'est jamais recalé.
        const bx = [m, r.width - WORLD_W * z - m];
        const by = [m, r.height - WORLD_H * z - m];
        tx = Math.min(Math.max(tx, Math.min(bx[0], bx[1])), Math.max(bx[0], bx[1]));
        ty = Math.min(Math.max(ty, Math.min(by[0], by[1])), Math.max(by[0], by[1]));
      }

      function apply() {
        clampPan();
        world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
        // Les noms de cadre gardent leur taille à l'écran, comme dans un
        // éditeur : illisibles à 20 %, énormes à 400 % sinon.
        for (const n of frameNames()) n.style.transform = 'scale(' + (1 / z) + ')';
        // Les traits de coupure gardent eux aussi une épaisseur d'écran
        // constante : à 10 % de zoom, une bande de 24px n'en fait plus que 2
        // et la fin de page redevient invisible.
        world.style.setProperty('--inv-z', String(1 / z));
        zVal.textContent = Math.round(z * 100) + ' %';
      }

      function fit(pad) {
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return;
        z = fitZoom(pad);
        tx = (r.width - WORLD_W * z) / 2;
        ty = (r.height - DOCK_SAFE - WORLD_H * z) / 2;
        apply();
      }
      /** Zoome en gardant fixe le point sous le curseur. */
      function zoomAt(clientX, clientY, factor) {
        const r = vp.getBoundingClientRect();
        const px = clientX - r.left, py = clientY - r.top;
        const nz = clampZ(z * factor);
        if (nz === z) return;
        tx = px - (px - tx) * (nz / z);
        ty = py - (py - ty) * (nz / z);
        z = nz;
        apply();
      }
      function zoomCenter(factor) {
        const r = vp.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
      }

      function onWheel(e, clientX, clientY) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          zoomAt(clientX, clientY, Math.exp(-e.deltaY * 0.0025));
        } else {
          tx -= e.deltaX; ty -= e.deltaY;
          apply();
        }
      }
      vp.addEventListener('wheel', (e) => onWheel(e, e.clientX, e.clientY), { passive: false });

      // --- Déplacement à la souris ---
      let panning = false, sx = 0, sy = 0, stx = 0, sty = 0, panId = null;
      vp.addEventListener('pointerdown', (e) => {
        if (e.button === 2) return;
        if (e.target.closest('.dock')) return;
        const board = e.target.closest('.board');
        const onShield = e.target.classList.contains('board-shield');
        // Hors mode édition les écrans de captage couvrent les cadres : on
        // peut donc attraper le plan de travail n'importe où. En mode édition
        // ils s'effacent pour laisser passer la souris vers la preview, et il
        // reste le fond, le bouton du milieu, ou Espace.
        if (!(e.button === 1 || spaceDown || onShield || !board)) return;
        panning = true; panId = e.pointerId;
        sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
        vp.setPointerCapture(e.pointerId);
        vp.classList.add('panning');
        e.preventDefault();
      });
      vp.addEventListener('pointermove', (e) => {
        if (!panning || e.pointerId !== panId) return;
        tx = stx + (e.clientX - sx); ty = sty + (e.clientY - sy);
        apply();
      });
      function endPan(e) {
        if (!panning) return;
        panning = false;
        vp.classList.remove('panning');
        try { vp.releasePointerCapture(e.pointerId); } catch {}
      }
      vp.addEventListener('pointerup', endPan);
      vp.addEventListener('pointercancel', endPan);
      vp.addEventListener('contextmenu', (e) => { if (spaceDown) e.preventDefault(); });

      // Cliquer à l'extérieur de la zone du CV / des contrôles désélectionne l'élément courant
      document.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && (e.target.closest('#scaleFrame') || e.target.closest('#editSidebar') || e.target.closest('.dock'))) {
          return;
        }
        post({ type: 'cv-deselect' });
      });

      // --- Clavier ---
      function setSpace(down) {
        if (spaceDown === down) return;
        spaceDown = down;
        document.body.classList.toggle('space', down);
      }
      function onKeyDown(e) {
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if (e.code === 'Space') { setSpace(true); e.preventDefault(); return; }
        if (e.shiftKey && e.key === '!') { fit(); e.preventDefault(); return; }   // Maj+1
        if (e.shiftKey && (e.key === '0' || e.key === 'à')) { z = 1; centerOnWorld(); e.preventDefault(); return; }
        if (e.key === '+' || e.key === '=') { zoomCenter(1.2); e.preventDefault(); return; }
        if (e.key === '-') { zoomCenter(1 / 1.2); e.preventDefault(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        const byKey = { h: 'none', v: 'all', t: 'text', i: 'img', b: 'div' };
        if (byKey[k]) { setTool(byKey[k]); e.preventDefault(); return; }
        if (k === 'o') { setOnion(!onionOn); e.preventDefault(); }
      }
      function onKeyUp(e) { if (e.code === 'Space') setSpace(false); }
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', () => setSpace(false));

      function centerOnWorld() {
        const r = vp.getBoundingClientRect();
        tx = (r.width - WORLD_W * z) / 2;
        ty = (r.height - WORLD_H * z) / 2;
        apply();
      }

      document.getElementById('zIn').addEventListener('click', () => zoomCenter(1.25));
      document.getElementById('zOut').addEventListener('click', () => zoomCenter(1 / 1.25));
      document.getElementById('zFit').addEventListener('click', () => fit());
      zVal.addEventListener('click', () => { z = 1; centerOnWorld(); });

      // Ouvrir le panneau d'inspection reprend de la largeur au plan de travail.
      // Recadrer d'office ferait sauter la vue : on décale de la moitié de ce
      // qui a été pris ou rendu, ce qui garde le point central sous les yeux.
      // La référence est conservée : un ResizeObserver dont la seule attache est
      // interne finit ramassé par le GC, et l'observation s'arrête en silence
      // après le tout premier appel.
      let lastW = 0, lastH = 0;
      const vpResize = new ResizeObserver(() => {
        const r = vp.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (!lastW) { fit(); }
        else { tx += (r.width - lastW) / 2; ty += (r.height - lastH) / 2; apply(); }
        lastW = r.width; lastH = r.height;
      });
      vpResize.observe(vp);

      // L'aide au pilotage a fait son office dès le premier geste.
      let hintGone = false;
      function dismissHint() {
        if (hintGone) return;
        hintGone = true;
        document.body.classList.add('hint-gone');
      }
      vp.addEventListener('wheel', dismissHint, { passive: true });
      vp.addEventListener('pointerdown', dismissHint);
      setTimeout(dismissHint, 9000);

      // La molette et Espace doivent aussi marcher quand le curseur est
      // au-dessus de la preview en mode édition -- l'iframe est de même
      // origine, on écoute donc directement dans son document.
      function bindFrameEvents() {
        try {
          const d = document.getElementById('scaleFrame').contentDocument;
          if (!d || d.__vpBound) return;
          d.__vpBound = true;
          d.addEventListener('wheel', (e) => {
            const r = document.getElementById('scaleFrame').getBoundingClientRect();
            onWheel(e, r.left + e.clientX * z, r.top + e.clientY * z);
          }, { passive: false });
          d.addEventListener('keydown', onKeyDown);
          d.addEventListener('keyup', onKeyUp);
        } catch {}
      }
      document.getElementById('scaleFrame').addEventListener('load', bindFrameEvents);
      bindFrameEvents();

      // ============================== Outils ==============================
      // La barre du bas porte le mode de travail. Changer d'outil ne détruit
      // jamais rien : seul « Annuler et quitter » recharge la preview. Le
      // script d'édition est injecté à la première demande et reste en place
      // ensuite -- l'outil « Parcourir » le laisse simplement inerte.
      let currentEdits = null;
      let tool = 'none';
      let onionOn = false;
      let overlayReady = false, overlayBusy = false, readyResolve = null;

      const saveBtn = document.getElementById('editSave');
      const sidebar = document.getElementById('editSidebar');
      const sbSel = document.getElementById('sbSel');
      const sbOnion = document.getElementById('sbOnion');
      const cancelBtn = document.getElementById('editCancel');
      const onionBtn = document.getElementById('onionBtn');
      const hint = document.getElementById('sbStatus');
      const frameEl = () => document.getElementById('scaleFrame');
      const isEditTool = (t) => t === 'all' || t === 'text' || t === 'img' || t === 'div';
      const post = (msg) => { const f = frameEl(); if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*'); };

      // Recharger l'iframe emporte le script injecté avec elle.
      frameEl().addEventListener('load', () => { overlayReady = false; });

      function waitReady(ms) {
        return new Promise((resolve) => {
          readyResolve = resolve;
          setTimeout(() => { if (readyResolve === resolve) { readyResolve = null; resolve(false); } }, ms);
        });
      }

      /** Injecte le script d'édition si besoin. needTags n'est vrai que pour
       *  les outils qui sélectionnent : le calque, lui, n'a pas besoin des
       *  repères posés dans le rendu. */
      async function ensureOverlay(needTags) {
        if (overlayReady) return true;
        if (overlayBusy) return false;
        overlayBusy = true;
        try {
          const frame = frameEl();
          // Les runs générés avant l'ajout des repères data-cvimg n'ont pas
          // d'éléments identifiables : on re-rend une fois (local, gratuit).
          // Un rendu produit avant l'ajout d'un type de repère laisserait
          // l'édition correspondante indisponible sans le dire : on compare
          // donc la version du schéma d'étiquetage plutôt que la présence
          // d'un attribut particulier.
          if (needTags) {
            const meta = frame.contentDocument.querySelector('meta[name="cv-tags"]');
            if (!meta || meta.content !== '4') {
              hint.textContent = "Préparation de l'éditeur...";
              const rr = await fetch('/runs/' + CV.runId + '/rerender', { method: 'POST' });
              if (!rr.ok) { hint.textContent = 'Préparation échouée : ' + (await rr.text()); return false; }
              await new Promise((resolve) => {
                frame.addEventListener('load', resolve, { once: true });
                frame.src = frame.src.split('?')[0] + '?t=' + Date.now();
              });
              bindFrameEvents();
            }
          }
          // Injecté comme code inline (et non via src) : pas de cache
          // navigateur possible, exécution immédiate, et une erreur de
          // chargement devient visible au lieu d'échouer en silence.
          const code = await (await fetch('/editor-overlay.js?t=' + Date.now())).text();
          const el = frame.contentDocument.createElement('script');
          el.textContent = code;
          const ready = waitReady(4000);
          frame.contentDocument.body.appendChild(el);
          if (!await ready) {
            hint.textContent = "L'éditeur ne s'est pas initialisé — regarde la console du navigateur.";
            return false;
          }
          return true;
        } catch (err) {
          // Une exception dans un gestionnaire async disparaît silencieusement,
          // et l'utilisateur voit juste un bouton qui « ne fait rien ».
          hint.textContent = 'Erreur : ' + err.message;
          console.error(err);
          return false;
        } finally {
          overlayBusy = false;
        }
      }

      async function setTool(next) {
        if (next === tool) return;
        if (isEditTool(next)) {
          if (!await ensureOverlay(true)) { syncDock(); return; }
          // Première entrée en édition : on amène la preview au centre, c'est
          // sur elle qu'on va travailler.
          if (!isEditTool(tool)) focusPreview();
        }
        tool = next;
        post({ type: 'cv-settool', tool });
        syncDock();
      }

      async function setOnion(on) {
        if (on && !await ensureOverlay(false)) { syncDock(); return; }
        onionOn = on;
        pushOnion();
        syncDock();
      }

      function syncDock() {
        for (const b of document.querySelectorAll('.dock .tool')) {
          b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
        }
        if (onionBtn) onionBtn.setAttribute('aria-pressed', String(onionOn));
        const editing = isEditTool(tool);
        document.body.classList.toggle('tool-edit', editing);
        document.getElementById('previewPane').classList.toggle('editing', editing);
        if (sbOnion) sbOnion.hidden = !onionOn;
        // Le panneau reste ouvert tant qu'il a quelque chose à montrer : un
        // outil actif, un réglage de calque, ou des modifications à enregistrer.
        const pending = currentEdits
          ? Object.keys(currentEdits.images).length + Object.keys(currentEdits.texts).length + Object.keys(currentEdits.classes).length
          : 0;
        const open = editing || onionOn || pending > 0;
        sidebar.classList.toggle('open', open);
        document.body.classList.toggle('editing-open', open);
        if (!editing) {
          post({ type: 'cv-deselect' });
          sbSel.innerHTML = '<div class="sb-row"><span>Aucune</span></div>';
          document.getElementById('sbSpacing').hidden = true;
        }
      }

      for (const b of document.querySelectorAll('.dock .tool')) {
        b.addEventListener('click', () => setTool(b.dataset.tool));
      }
      if (onionBtn) onionBtn.addEventListener('click', () => setOnion(!onionOn));

      /** Cadre la preview seule, à une échelle où les poignées sont saisissables. */
      function focusPreview() {
        const r = vp.getBoundingClientRect();
        z = clampZ(Math.min((r.width - 64) / CV.W, (r.height - DOCK_SAFE - 64) / CV.previewH));
        tx = (r.width - CV.W * z) / 2 - CV.boardOffset * z;
        ty = (r.height - DOCK_SAFE - CV.previewH * z) / 2;
        apply();
      }

      window.addEventListener('message', async (e) => {
        if (!e.data) return;
        if (e.data.type === 'cv-editor-ready') {
          overlayReady = true;
          if (readyResolve) { const r = readyResolve; readyResolve = null; r(true); }
          const parts = [];
          if (e.data.count) parts.push(e.data.count + ' image' + (e.data.count > 1 ? 's' : ''));
          if (e.data.texts) parts.push(e.data.texts + ' texte' + (e.data.texts > 1 ? 's' : ''));
          hint.textContent = parts.length ? parts.join(' · ') + ' éditables' : "Rien d'éditable dans ce rendu";
          post({ type: 'cv-settool', tool });
          pushOnion();
        }
        if (e.data.type === 'cv-select') {
          const sel = e.data.sel;
          const spacingBox = document.getElementById('sbSpacing');
          if (!sel) {
            sbSel.innerHTML = '<div class="sb-row"><span>Aucune</span></div>';
            spacingBox.hidden = true;
          } else if (sel.kind === 'text') {
            sbSel.innerHTML = '<div class="sb-row"><span>Texte</span><span>#' + sel.id + '</span></div>'
              + '<div class="sb-row"><span>Contenu</span><span>' + (sel.label || '—') + '</span></div>'
              + (sel.instances > 1 ? '<div class="sb-row"><span>Instances</span><span>' + sel.instances + '</span></div>' : '');
            spacingBox.hidden = false;
            for (const inp of document.querySelectorAll('.pad-in')) inp.value = sel[inp.dataset.side];
            for (const btn of document.querySelectorAll('.mode-btn')) {
              btn.classList.toggle('active', btn.dataset.mode === sel.mode);
            }
          } else {
            sbSel.innerHTML = '<div class="sb-row"><span>Image</span><span>#' + sel.id + '</span></div>'
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Largeur</span><input type="number" step="0.1" min="0" class="pad-in img-in" data-prop="width" value="' + sel.width + '"></div>'
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Hauteur</span><input type="number" step="0.1" min="0" class="pad-in img-in" data-prop="height" value="' + sel.height + '"></div>'
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>X</span><input type="number" step="0.1" class="pad-in img-in" data-prop="left" value="' + sel.left + '"></div>'
              + '<div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Y</span><input type="number" step="0.1" class="pad-in img-in" data-prop="top" value="' + sel.top + '"></div>';
            spacingBox.hidden = true;
          }
          bindScrubbers();
        }
        if (e.data.type === 'cv-edits') {
          currentEdits = { images: e.data.edits, texts: e.data.textEdits || {}, classes: e.data.classEdits || {} };
          const n = Object.keys(currentEdits.images).length + Object.keys(currentEdits.texts).length
            + Object.keys(currentEdits.classes).length;
          // Après une annulation on peut revenir à zéro modification :
          // le bouton doit alors se désactiver, pas rester actif à vide.
          saveBtn.disabled = n === 0;
          hint.textContent = n ? n + ' modification(s) en attente' : 'Aucune modification';
          syncDock();
        }
      });

      // Les raccourcis frappés alors que le focus est sur la page parente
      // (juste après un clic sur un bouton, par exemple) sont relayés à
      // l'iframe, qui détient l'historique.
      document.addEventListener('keydown', (e) => {
        if (!isEditTool(tool)) return;
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const frame = document.getElementById('scaleFrame');
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          frame.contentWindow.postMessage({ type: e.shiftKey ? 'cv-redo' : 'cv-undo' }, '*');
        } else if (k === 'y') {
          e.preventDefault();
          frame.contentWindow.postMessage({ type: 'cv-redo' }, '*');
        }
      });

      saveBtn.addEventListener('click', async () => {
        if (!currentEdits) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Enregistrement...';
        const r = await fetch('/runs/' + CV.runId + '/image-edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edits: currentEdits.images, textEdits: currentEdits.texts, classEdits: currentEdits.classes }),
        });
        if (r.ok) { location.reload(); }
        else { saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer'; hint.textContent = 'Échec : ' + (await r.text()); }
      });

      cancelBtn.addEventListener('click', () => {
        const frame = frameEl();
        frame.src = frame.src; // recharge : annule les ajustements non enregistrés
        currentEdits = null;
        tool = 'none';
        onionOn = false;
        saveBtn.disabled = true;
        hint.textContent = 'Aucune modification';
        syncDock();
      });

      const frameWin = () => document.getElementById('scaleFrame').contentWindow;
      function bindScrubbers() {
        document.querySelectorAll('#editSidebar .sb-row.scrubbable').forEach((row) => {
          if (row.__scrubBound) return;
          row.__scrubBound = true;
          const input = row.querySelector('input');
          if (!input) return;
          const label = row.querySelector('span:first-child');

          const triggerChange = () => {
            if (input.classList.contains('img-in')) {
              frameWin().postMessage({ type: 'cv-setgeom-em', [input.dataset.prop]: Number(input.value) }, '*');
            } else {
              frameWin().postMessage({ type: 'cv-setspacing-em', side: input.dataset.side, em: Number(input.value) }, '*');
            }
          };

          // La saisie manuelle au clavier fonctionne à 100% sans bloquer le focus
          input.addEventListener('input', triggerChange);
          input.addEventListener('change', triggerChange);

          // Le glisser-déposer (scrubbing) s'effectue uniquement sur le libellé (span)
          if (label) {
            let isDragging = false;
            let startX = 0;
            let startVal = 0;

            label.addEventListener('pointerdown', (e) => {
              isDragging = true;
              startX = e.clientX;
              startVal = Number(input.value) || 0;
              label.setPointerCapture(e.pointerId);
              document.body.classList.add('scrubbing');
              e.preventDefault();
            });

            label.addEventListener('pointermove', (e) => {
              if (!isDragging) return;
              const dx = e.clientX - startX;
              const step = e.shiftKey ? 1.0 : (e.altKey ? 0.01 : 0.1);
              let newVal = Math.round((startVal + dx * step * 0.5) * 100) / 100;
              if (input.min !== "" && newVal < Number(input.min)) newVal = Number(input.min);
              input.value = newVal;
              triggerChange();
            });

            const endDrag = (e) => {
              if (!isDragging) return;
              isDragging = false;
              document.body.classList.remove('scrubbing');
              try { label.releasePointerCapture(e.pointerId); } catch {}
            };

            label.addEventListener('pointerup', endDrag);
            label.addEventListener('pointercancel', endDrag);

            label.addEventListener('wheel', (e) => {
              e.preventDefault();
              const step = e.shiftKey ? 1.0 : (e.altKey ? 0.01 : 0.1);
              const delta = e.deltaY < 0 ? step : -step;
              let newVal = Math.round(((Number(input.value) || 0) + delta) * 100) / 100;
              if (input.min !== "" && newVal < Number(input.min)) newVal = Number(input.min);
              input.value = newVal;
              triggerChange();
            }, { passive: false });
          }

          // Molette sur l'input directement
          input.addEventListener('wheel', (e) => {
            if (document.activeElement === input) return;
            e.preventDefault();
            const step = e.shiftKey ? 1.0 : (e.altKey ? 0.01 : 0.1);
            const delta = e.deltaY < 0 ? step : -step;
            let newVal = Math.round(((Number(input.value) || 0) + delta) * 100) / 100;
            if (input.min !== "" && newVal < Number(input.min)) newVal = Number(input.min);
            input.value = newVal;
            triggerChange();
          }, { passive: false });
        });
      }
      bindScrubbers();

      for (const btn of document.querySelectorAll('.mode-btn')) {
        btn.addEventListener('click', () => {
          frameWin().postMessage({ type: 'cv-setmode', mode: btn.dataset.mode }, '*');
        });
      }

      // Calque de décalque : la capture cible superposée en transparence
      // par-dessus la preview, pour aligner les éléments à l'oeil.
      const onionOpacity = document.getElementById('onionOpacity');
      const onionVal = document.getElementById('onionVal');
      function pushOnion() {
        if (!onionOpacity) return;
        post({
          type: 'cv-onion',
          src: CV.target,
          on: onionOn,
          opacity: Number(onionOpacity.value) / 100,
        });
        if (onionVal) onionVal.textContent = onionOpacity.value + ' %';
      }
      if (onionOpacity) onionOpacity.addEventListener('input', pushOnion);

      syncDock();
