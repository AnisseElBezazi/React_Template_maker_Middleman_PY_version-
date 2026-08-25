// Éditeur visuel type Figma injecté DANS l'iframe de preview : sélection au
// clic, cadre avec poignées, glisser pour déplacer, poignées pour
// redimensionner, flèches pour ajuster au pixel.
//
// Il travaille en pixels du canvas (le document interne n'est pas mis à
// l'échelle lui-même : c'est l'iframe qui l'est côté parent, donc les
// deltas de souris arrivent déjà convertis dans le bon repère), puis
// convertit en `em` au moment d'envoyer les modifications au parent -- le
// composant étant responsive, seules des valeurs relatives à la police
// racine restent correctes à une autre taille de canvas.

(function () {
  const doc = document;
  const edits = {};       // images : position / taille
  const textEdits = {};   // blocs de texte : marges intérieures / extérieures
  const classEdits = {};  // idem, mais pour les éléments rendus par le moteur
  let selected = null;
  let drag = null;
  // Un bloc de texte s'ajuste soit en marge INTÉRIEURE (padding), soit en
  // marge EXTÉRIEURE (margin) ; on bascule avec P / M.
  let spacingMode = "padding";

  // "cls" : élément rendu par le moteur PARTAGÉ (titres de section). On ne
  // touchera pas au moteur : l'ajustement ira modifier la classe que le
  // composant généré lui passe. Il s'édite donc comme un bloc de texte, mais
  // s'enregistre sous sa classe et non sous un index de balise.
  const kindOf = (el) => {
    if (!el) return "text";
    if (el.dataset.cvimg !== undefined) return "img";
    if (el.dataset.cvcls !== undefined) return "cls";
    return "text";
  };
  const isTextLike = (el) => kindOf(el) !== "img";

  /** Toutes les instances rendues par LA MÊME balise source. Une balise dans
   * une boucle produit plusieurs éléments à l'écran : les styler toutes rend
   * l'aperçu conforme à ce que produira la réécriture du JSX. */
  function sameEls(el) {
    if (!el) return [];
    if (kindOf(el) === "cls") {
      return Array.from(doc.querySelectorAll("[data-cvcls]")).filter((n) => n.className === el.className);
    }
    const sel = el.dataset.cvimg !== undefined
      ? `img[data-cvimg="${el.dataset.cvimg}"]`
      : `[data-cvtext="${el.dataset.cvtext}"]`;
    return Array.from(doc.querySelectorAll(sel));
  }

  // Une longueur en `em` se résout d'après la police de L'ÉLÉMENT LUI-MÊME
  // (pas celle de la racine) : `w-[12em]` sur une image placée dans un
  // conteneur en `text-[0.8em]` ne vaut pas la même chose qu'à la racine.
  // On convertit donc avec la police calculée de l'élément édité.
  const emOf = (el) => parseFloat(getComputedStyle(el).fontSize) || 16;
  const toEm = (px, el) => Math.round((px / emOf(el)) * 100) / 100;

  // La preview est affichée réduite (l'iframe porte un transform: scale).
  // Sans compensation, un cadre de 2px et des poignées de 12px deviennent
  // quasi invisibles et impossibles à attraper : on divise donc les tailles
  // d'interface par l'échelle pour qu'elles restent constantes à l'écran.
  const frameScale = (() => {
    try {
      const m = new DOMMatrix(getComputedStyle(window.frameElement).transform);
      return m.a > 0.05 ? m.a : 1;
    } catch {
      return 1;
    }
  })();
  const ui = (px) => Math.round((px / frameScale) * 10) / 10;

  const style = doc.createElement("style");
  style.textContent = `
    /* Beaucoup d'images décoratives portent pointer-events-none (filigrane,
       fond) : sans ça elles seraient les seules impossibles à sélectionner,
       alors que ce sont précisément celles qu'on vient corriger. */
    /* Une <img> est nativement "draggable" : sans ça, appuyer puis glisser
       déclenche le glisser-déposer natif du navigateur (image fantôme), qui
       avale les mousemove -- l'élément ne bouge donc jamais. Invisible en
       test automatisé, bloquant pour un vrai utilisateur. */
    img[data-cvimg] { pointer-events: auto !important; -webkit-user-drag: none; user-select: none; }
    #cv-editing-body, #cv-editing-body * { user-select: none !important; }
    /* Le curseur annonce ce qui va se passer : main ouverte sur une image,
       main fermée pendant le déplacement, double flèche sur les poignées
       (diagonale aux coins, horizontale ou verticale aux arêtes). */
    img[data-cvimg] { cursor: grab; }
    html.cv-drag-move, html.cv-drag-move * { cursor: grabbing !important; }
    html.cv-drag-n, html.cv-drag-n * { cursor: n-resize !important; }
    html.cv-drag-s, html.cv-drag-s * { cursor: s-resize !important; }
    html.cv-drag-e, html.cv-drag-e * { cursor: e-resize !important; }
    html.cv-drag-w, html.cv-drag-w * { cursor: w-resize !important; }
    html.cv-drag-nw, html.cv-drag-nw * { cursor: nw-resize !important; }
    html.cv-drag-ne, html.cv-drag-ne * { cursor: ne-resize !important; }
    html.cv-drag-sw, html.cv-drag-sw * { cursor: sw-resize !important; }
    html.cv-drag-se, html.cv-drag-se * { cursor: se-resize !important; }
    /* Pas de contour permanent : il défigurait la preview. Le repérage se
       fait au survol uniquement, et le panneau latéral liste ce qui est
       éditable. */
    img[data-cvimg]:hover { outline: ${ui(1.5)}px solid rgba(99,102,241,0.9); outline-offset: ${ui(1)}px; }
    #cv-sel { position: absolute; border: ${ui(2)}px solid #6366f1; pointer-events: none; z-index: 999998;
              box-shadow: 0 0 0 ${ui(1)}px rgba(255,255,255,0.9); }
    .cv-h { position: absolute; width: ${ui(12)}px; height: ${ui(12)}px; background: #fff;
            border: ${ui(2)}px solid #6366f1; border-radius: ${ui(2)}px; pointer-events: auto; z-index: 999999; }
    /* Flèches DIRECTIONNELLES : la poignée de droite pointe vers la droite,
       celle de gauche vers la gauche, etc. -- le curseur indique le côté
       qu'on va tirer, pas seulement l'axe. */
    .cv-h.n { cursor: n-resize } .cv-h.s { cursor: s-resize }
    .cv-h.e { cursor: e-resize } .cv-h.w { cursor: w-resize }
    .cv-h.nw { cursor: nw-resize } .cv-h.ne { cursor: ne-resize }
    .cv-h.sw { cursor: sw-resize } .cv-h.se { cursor: se-resize }
  `;
  doc.head.appendChild(style);

  // Ceinture et bretelles : l'attribut draggable et l'événement dragstart
  // sont désactivés explicitement, la propriété CSS ne suffisant pas sur
  // tous les navigateurs.
  doc.body.id = doc.body.id || "cv-editing-body";
  for (const img of doc.querySelectorAll("img[data-cvimg]")) {
    img.draggable = false;
    // Toutes les images sont déplaçables. Une image hors flux (filigrane
    // centré dans un conteneur, par exemple) passe en `absolute` au premier
    // déplacement : elle n'a en pratique pas de voisin à décaler, et
    // l'interdire rendait inaccessibles précisément les décors à recaler.
    img.dataset.cvMovable = "1";
  }

  const DRAG_CLASS = { move: "cv-drag-move" };
  for (const d of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) DRAG_CLASS[d] = "cv-drag-" + d;
  const ALL_DRAG_CLASSES = Object.values(DRAG_CLASS);
  const setDragCursor = (key) => {
    doc.documentElement.classList.remove(...ALL_DRAG_CLASSES);
    if (key && DRAG_CLASS[key]) doc.documentElement.classList.add(DRAG_CLASS[key]);
  };
  doc.addEventListener("dragstart", (e) => {
    if (e.target && e.target.closest && e.target.closest("img[data-cvimg]")) e.preventDefault();
  });

  const box = doc.createElement("div");
  box.id = "cv-sel";
  box.style.display = "none";
  for (const pos of ["nw", "ne", "sw", "se", "n", "s", "e", "w"]) {
    const h = doc.createElement("div");
    h.className = "cv-h " + pos;
    h.dataset.handle = pos;
    box.appendChild(h);
  }
  doc.body.appendChild(box);

  /** Image éditable située sous le curseur, même si elle est RECOUVERTE.
   * Indispensable : dans les composants générés, le bloc de contenu est
   * souvent empilé au-dessus des images de décor (logo, filigrane, coin),
   * si bien que le clic atterrit sur un <p> ou un <div> et que l'image
   * paraît inerte. On parcourt donc toute la pile de points, pas seulement
   * l'élément du dessus. */
  function imgAtPoint(x, y) {
    const stack = doc.elementsFromPoint(x, y) || [];
    // Les images d'abord : ce sont les plus petites cibles, et elles sont
    // souvent recouvertes par le bloc de contenu.
    for (const el of stack) {
      if (el.matches && el.matches("img[data-cvimg]")) return el;
    }
    for (const el of stack) {
      if (el.matches && el.matches("[data-cvtext],[data-cvcls]")) return el;
    }
    return null;
  }

  // Une image pivotée (filigrane vertical, très courant) a ses axes internes
  // tournés : `width` s'étend verticalement à l'écran. Sans en tenir compte,
  // tirer la poignée de droite modifierait sa hauteur -- d'où une sensation
  // d'inversion. On convertit donc la souris et le nom de la poignée du
  // repère ÉCRAN vers le repère PROPRE de l'élément.
  const COMPASS = ["e", "se", "s", "sw", "w", "nw", "n", "ne"];

  /** Nombre de quarts de tour de l'élément (0 si non pivoté). */
  function quarterTurns(el) {
    const t = getComputedStyle(el).transform;
    if (!t || t === "none") return 0;
    try {
      const m = new DOMMatrix(t);
      return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI / 90);
    } catch {
      return 0;
    }
  }

  /** Poignée écran -> poignée dans le repère de l'élément. */
  function localHandle(handle, k) {
    if (!k) return handle;
    const i = COMPASS.indexOf(handle);
    if (i === -1) return handle;
    return COMPASS[(((i - 2 * k) % 8) + 8) % 8];
  }

  /** Déplacement souris écran -> déplacement dans le repère de l'élément. */
  function localDelta(dx, dy, k) {
    if (!k) return [dx, dy];
    const c = [1, 0, -1, 0][((k % 4) + 4) % 4];
    const s = [0, 1, 0, -1][((k % 4) + 4) % 4];
    return [dx * c + dy * s, -dx * s + dy * c];
  }

  /** Position de l'élément dans le repère de son parent positionné --
   * c'est ce même repère qu'interprètent `left`/`top` en CSS. */
  function geom(el) {
    return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
  }

  function drawBox() {
    if (!selected) return (box.style.display = "none");
    const r = selected.getBoundingClientRect();
    const sx = window.scrollX;
    const sy = window.scrollY;
    box.style.display = "block";
    box.style.left = r.left + sx + "px";
    box.style.top = r.top + sy + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    const hs = box.querySelectorAll(".cv-h");
    const at = {
      nw: [0, 0], ne: [r.width, 0], sw: [0, r.height], se: [r.width, r.height],
      n: [r.width / 2, 0], s: [r.width / 2, r.height], e: [r.width, r.height / 2], w: [0, r.height / 2],
    };
    const half = ui(12) / 2;
    hs.forEach((h) => {
      const [x, y] = at[h.dataset.handle];
      h.style.left = x - half + "px";
      h.style.top = y - half + "px";
    });
  }

  // Historique annuler / rétablir. Un instantané mémorise le `style` inline
  // complet de chaque image (donc aussi ce que React y avait mis) : le
  // restaurer tel quel remet exactement l'état précédent, sans avoir à
  // rejouer les transformations à l'envers.
  const history = [];
  let histIndex = -1;

  function snapshot() {
    const styles = new Map();
    for (const el of doc.querySelectorAll("img[data-cvimg],[data-cvtext],[data-cvcls]")) {
      styles.set(el, el.style.cssText);
    }
    return {
      styles,
      edits: JSON.parse(JSON.stringify(edits)),
      textEdits: JSON.parse(JSON.stringify(textEdits)),
      classEdits: JSON.parse(JSON.stringify(classEdits)),
    };
  }

  function pushHistory() {
    // Toute nouvelle action efface la branche "rétablir" devenue obsolète.
    history.splice(histIndex + 1);
    history.push(snapshot());
    histIndex = history.length - 1;
  }

  function applySnapshot(snap) {
    for (const [el, css] of snap.styles) el.style.cssText = css;
    for (const k of Object.keys(edits)) delete edits[k];
    Object.assign(edits, JSON.parse(JSON.stringify(snap.edits)));
    for (const k of Object.keys(textEdits)) delete textEdits[k];
    Object.assign(textEdits, JSON.parse(JSON.stringify(snap.textEdits)));
    for (const k of Object.keys(classEdits)) delete classEdits[k];
    Object.assign(classEdits, JSON.parse(JSON.stringify(snap.classEdits)));
    drawBox();
    parent.postMessage({ type: "cv-edits", edits, textEdits, classEdits }, "*");
    notifySelection();
  }

  function undo() {
    if (histIndex <= 0) return;
    histIndex -= 1;
    applySnapshot(history[histIndex]);
  }

  function redo() {
    if (histIndex >= history.length - 1) return;
    histIndex += 1;
    applySnapshot(history[histIndex]);
  }

  const SIDES = { n: "Top", e: "Right", s: "Bottom", w: "Left" };

  /** Valeur courante d'une marge (intérieure ou extérieure) en pixels. */
  function spacingPx(el, side, mode) {
    return parseFloat(getComputedStyle(el)[mode + SIDES[side]]) || 0;
  }

  /** Applique une marge à TOUTES les instances de la balise source. */
  function setSpacing(el, side, mode, px) {
    const prop = mode + SIDES[side];
    for (const node of sameEls(el)) node.style[prop] = Math.max(0, px) + "px";
  }

  function record() {
    if (!selected) return;
    if (isTextLike(selected)) {
      const byClass = kindOf(selected) === "cls";
      const key = byClass ? selected.className : selected.dataset.cvtext;
      const bag = byClass ? classEdits : textEdits;
      const entry = bag[key] || (bag[key] = {});
      for (const side of ["n", "e", "s", "w"]) {
        for (const mode of ["padding", "margin"]) {
          const cur = spacingPx(selected, side, mode);
          const inline = selected.style[mode + SIDES[side]];
          // On n'inscrit que ce qui a été explicitement posé par l'éditeur,
          // pour ne pas figer dans le JSX des valeurs héritées du thème.
          if (inline) entry[mode + SIDES[side]] = toEm(cur, selected);
        }
      }
      parent.postMessage({ type: "cv-edits", edits, textEdits, classEdits }, "*");
      notifySelection();
      pushHistory();
      return;
    }
    const id = selected.dataset.cvimg;
    const g = geom(selected);
    const movable = selected.dataset.cvMovable === "1";
    edits[id] = movable
      ? {
          left: toEm(g.left, selected),
          top: toEm(g.top, selected),
          width: toEm(g.width, selected),
          height: toEm(g.height, selected),
        }
      : { width: toEm(g.width, selected), height: toEm(g.height, selected) };
    parent.postMessage({ type: "cv-edits", edits, textEdits, classEdits }, "*");
    notifySelection();
    pushHistory();
  }

  /** Informe le panneau latéral de l'élément sélectionné et de sa géométrie
   * courante, pour qu'il l'affiche sans rien surimprimer sur la preview. */
  function notifySelection() {
    if (!selected) return parent.postMessage({ type: "cv-select", sel: null }, "*");
    const g = geom(selected);
    if (isTextLike(selected)) {
      const vals = {};
      for (const side of ["n", "e", "s", "w"]) {
        vals[side] = toEm(spacingPx(selected, side, spacingMode), selected);
      }
      return parent.postMessage({
        type: "cv-select",
        sel: {
          kind: "text",
          id: kindOf(selected) === "cls" ? "titre de section" : selected.dataset.cvtext,
          mode: spacingMode,
          instances: sameEls(selected).length,
          label: (selected.textContent || "").trim().slice(0, 24),
          ...vals,
        },
      }, "*");
    }
    parent.postMessage({
      type: "cv-select",
      sel: {
        kind: "img",
        id: selected.dataset.cvimg,
        left: toEm(g.left, selected),
        top: toEm(g.top, selected),
        width: toEm(g.width, selected),
        height: toEm(g.height, selected),
      },
    }, "*");
  }

  function select(el) {
    selected = el;
    if (el) {
      el.dataset.cvMovable = "1";
    }
    // Pour un bloc de texte on n'ajuste que les quatre côtés : les
    // poignées d'angle n'auraient pas de sens sur une marge.
    const isText = el && isTextLike(el);
    for (const h of box.querySelectorAll(".cv-h")) {
      const corner = h.dataset.handle.length === 2;
      h.style.display = isText && corner ? "none" : "block";
    }
    drawBox();
    notifySelection();
  }

  // Pointer Events plutôt que Mouse Events, pour pouvoir CAPTURER le
  // pointeur : sans capture, dès que la souris sort de l'iframe pendant un
  // glisser (ce qui arrive tout le temps, la preview étant réduite dans un
  // panneau), l'iframe cesse de recevoir les mousemove et le déplacement
  // s'interrompt en plein milieu.
  doc.addEventListener("pointerdown", (e) => {
    const capture = () => {
      try {
        doc.documentElement.setPointerCapture(e.pointerId);
      } catch { /* capture indisponible : on continue sans */ }
    };

    const handle = e.target.closest(".cv-h");
    if (handle && selected) {
      const g = geom(selected);
      if (isTextLike(selected)) {
        const side = handle.dataset.handle;
        drag = {
          mode: "spacing", side, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId,
          start: spacingPx(selected, side, spacingMode),
        };
        setDragCursor(side);
        capture();
        e.preventDefault();
        return;
      }
      drag = { mode: "resize", corner: handle.dataset.handle, x0: e.clientX, y0: e.clientY, g, pointerId: e.pointerId, turns: quarterTurns(selected) };
      setDragCursor(handle.dataset.handle);
      capture();
      e.preventDefault();
      return;
    }
    const img = imgAtPoint(e.clientX, e.clientY);
    if (img) {
      select(img);
      if (isTextLike(img)) {
        e.preventDefault();
        return; // un bloc de texte s'ajuste par ses poignées, pas en le traînant
      }
      if (img.dataset.cvMovable === "1") {
        drag = { mode: "move", x0: e.clientX, y0: e.clientY, g: geom(img), pointerId: e.pointerId };
        setDragCursor("move");
        capture();
      }
      e.preventDefault();
    } else if (!e.target.closest("#cv-sel")) {
      select(null);
    }
  });

  doc.addEventListener("pointermove", (e) => {
    if (!drag || !selected) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (dx || dy) drag.moved = true;
    const g = drag.g;

    if (drag.mode === "spacing") {
      // On tire VERS L'INTÉRIEUR pour augmenter une marge intérieure,
      // VERS L'EXTÉRIEUR pour une marge extérieure -- dans les deux cas le
      // geste va dans le sens où l'espace grandit.
      const inward = { n: dy, s: -dy, w: dx, e: -dx }[drag.side];
      const delta = spacingMode === "padding" ? inward : -inward;
      setSpacing(selected, drag.side, spacingMode, drag.start + delta);
      drawBox();
      return;
    }

    if (drag.mode === "move") {
      selected.style.position = "absolute";
      selected.style.right = "auto";
      selected.style.bottom = "auto";
      selected.style.left = g.left + dx + "px";
      selected.style.top = g.top + dy + "px";
    } else {
      // Une poignée agit sur les côtés que son nom contient : "se" tire le
      // bas ET la droite, "e" seulement la droite, "n" seulement le haut.
      // Les côtés non concernés restent fixes, ce qui donne le
      // comportement attendu -- tirer l'arête droite n'écarte que la droite.
      const ratio = g.width / g.height;
      const c = localHandle(drag.corner, drag.turns);
      const east = c.includes("e");
      const west = c.includes("w");
      const south = c.includes("s");
      const north = c.includes("n");

      // Deltas exprimés dans le repère propre de l'élément (identiques à dx/dy
      // s'il n'est pas pivoté).
      const [ldx, ldy] = localDelta(dx, dy, drag.turns);
      let w = g.width;
      let h = g.height;
      if (east) w = g.width + ldx;
      if (west) w = g.width - ldx;
      if (south) h = g.height + ldy;
      if (north) h = g.height - ldy;

      // Maj = conserver les proportions : sur une arête, la dimension
      // laissée libre suit celle qu'on tire.
      if (e.shiftKey) {
        if (east || west) h = w / ratio;
        else if (north || south) w = h * ratio;
      }

      w = Math.max(4, w);
      h = Math.max(4, h);
      selected.style.width = w + "px";
      selected.style.height = h + "px";
      selected.style.maxWidth = "none";

      // Tirer vers la gauche ou vers le haut déplace aussi l'origine, sinon
      // l'élément grandirait vers le côté opposé à celui qu'on tire.
      // `left` et `top` sont TOUJOURS réécrits : beaucoup d'images sont
      // placées via `right`/`bottom`, et neutraliser ces propriétés sans
      // fixer les autres ferait retomber l'élément à l'origine du parent.
      selected.style.position = "absolute";
      selected.style.right = "auto";
      selected.style.bottom = "auto";
      let newLeft = west ? g.left + (g.width - w) : g.left;
      let newTop = north ? g.top + (g.height - h) : g.top;

      // Élément pivoté d'un quart de tour : la rotation étant appliquée
      // autour du CENTRE, la boîte visible à l'écran vaut
      //   écran_gauche = left + largeur/2 - hauteur/2
      //   écran_haut   = top  + hauteur/2 - largeur/2
      // Les DEUX dimensions influencent donc CHAQUE coordonnée écran :
      // modifier la seule hauteur décalait aussi le haut, ce qui faisait
      // glisser l'image alors qu'un seul côté était tiré. On résout donc
      // directement pour que le bord opposé à la poignée reste immobile.
      if (drag.turns % 2 !== 0) {
        const dW = w - g.width;
        const dH = h - g.height;
        const sh = drag.corner; // poignée telle qu'elle apparaît à l'écran
        const dScreenLeft = sh.includes("w") ? -dH : 0; // bord droit ancré
        const dScreenTop = sh.includes("n") ? -dW : 0; // bord bas ancré
        newLeft = g.left + dScreenLeft - dW / 2 + dH / 2;
        newTop = g.top + dScreenTop - dH / 2 + dW / 2;
      }

      // Maj : on redimensionne DEPUIS LE CENTRE -- il reste au même endroit
      // et l'élément grandit symétriquement des deux côtés (au lieu
      // d'ancrer le bord opposé). La rotation s'appliquant autour du centre,
      // le centre à l'écran coïncide avec le centre de la boîte de mise en
      // page : la même formule vaut donc pour une image pivotée.
      if (e.shiftKey) {
        newLeft = g.left + (g.width - w) / 2;
        newTop = g.top + (g.height - h) / 2;
      }

      selected.style.left = newLeft + "px";
      selected.style.top = newTop + "px";
    }
    drawBox();
  });

  doc.addEventListener("pointerup", (e) => {
    if (drag && drag.pointerId != null) {
      try { doc.documentElement.releasePointerCapture(drag.pointerId); } catch { /* déjà relâché */ }
    }
    // Un simple clic ne doit pas compter comme une modification : sinon
    // sélectionner une image pour la regarder proposerait déjà de
    // l'enregistrer, et on sauvegarderait des changements inexistants.
    if (drag && drag.moved) record();
    drag = null;
    setDragCursor(null);
  });

  doc.addEventListener("keydown", (e) => {
    // Annuler / rétablir : Ctrl+Z et Ctrl+Y, plus les équivalents macOS
    // (Cmd+Z, Cmd+Maj+Z). Actif même sans sélection.
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      return redo();
    }
    if (e.key.toLowerCase() === "p" || e.key.toLowerCase() === "m") {
      spacingMode = e.key.toLowerCase() === "p" ? "padding" : "margin";
      parent.postMessage({ type: "cv-mode", mode: spacingMode }, "*");
      notifySelection();
      e.preventDefault();
      return;
    }
    if (!selected) return;
    if (e.key === "Escape") return select(null);
    const step = e.shiftKey ? 10 : 1;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = map[e.key];
    if (!d || selected.dataset.cvMovable !== "1") return;
    const g = geom(selected);
    selected.style.position = "absolute";
    selected.style.right = "auto";
    selected.style.bottom = "auto";
    selected.style.left = g.left + d[0] + "px";
    selected.style.top = g.top + d[1] + "px";
    record();
    drawBox();
    e.preventDefault();
  });

  window.addEventListener("message", (e) => {
    if (!e.data) return;
    // Le raccourci peut être frappé alors que le focus est sur la page
    // parente (juste après un clic sur un bouton) : celle-ci nous le relaie.
    if (e.data.type === "cv-deselect") select(null);
    if (e.data.type === "cv-setspacing-em" && selected && isTextLike(selected)) {
      setSpacing(selected, e.data.side, spacingMode, e.data.em * emOf(selected));
      record();
    }
    if (e.data.type === "cv-setmode") {
      spacingMode = e.data.mode;
      notifySelection();
    }
    if (e.data.type === "cv-undo") undo();
    if (e.data.type === "cv-redo") redo();

    // Calque de décalque : la capture cible posée PAR-DESSUS la preview en
    // transparence. Au-dessus et non dessous, car le composant a un fond
    // opaque -- un calque placé derrière serait tout simplement invisible.
    if (e.data.type === "cv-onion") {
      let onion = doc.getElementById("cv-onion");
      if (!e.data.on || !e.data.src) {
        if (onion) onion.remove();
        return;
      }
      if (!onion) {
        onion = doc.createElement("img");
        onion.id = "cv-onion";
        onion.style.cssText =
          "position:absolute;left:0;top:0;width:100%;height:auto;pointer-events:none;z-index:999990;";
        doc.body.appendChild(onion);
      }
      if (onion.getAttribute("src") !== e.data.src) onion.src = e.data.src;
      onion.style.opacity = String(e.data.opacity);
    }
  });

  // Numéro de version renvoyé à l'interface : permet de vérifier d'un coup
  // d'oeil que le navigateur exécute bien la dernière version du script et
  // pas une copie en cache.
  pushHistory(); // état initial, cible du dernier "annuler"
  parent.postMessage({ type: "cv-editor-ready", count: doc.querySelectorAll("img[data-cvimg]").length }, "*");
})();
