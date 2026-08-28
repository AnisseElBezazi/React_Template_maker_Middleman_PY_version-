// Interface web locale pour la pipeline Design-to-Code : glisser-déposer un
// PDF, suivi de la génération, puis comparaison PDF cible / preview React
// live côte à côte.
//
// Usage: node server.mjs  (puis ouvrir http://localhost:5050)

import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { runPipeline } from "./lib/pipeline.mjs";
import { runJinjaPipeline } from "./src/extraction/jinja_pipeline.mjs";
import { stackedTarget, targetPages } from "./src/rendering/stack_targets.mjs";
import { runs, getRun, listRuns, runWhen } from "./src/runs/runs_service.mjs";
import { runsRail } from "./src/views/components/runs_rail_view.mjs";
import { downloadUrls } from "./src/download/download_urls.mjs";
import { editorUrls } from "./src/editor/editor_urls.mjs";
import { OUT_ROOT, UPLOADS_ROOT, TEMPLATES_ROOT, PUBLIC_ROOT, ensureRoots, toPublicUrl } from "./src/shared/paths_shared.mjs";
import { esc } from "./src/shared/html_shared.mjs";
import { LOGO, ICON } from "./src/views/components/icons_view.mjs";
import { layout } from "./src/views/layout_view.mjs";
import { STAGES, JINJA_STAGES, renderStages } from "./src/views/components/stages_view.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });
ensureRoots();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_ROOT,
    filename: (_req, file, cb) => {
      let ext = ".pdf";
      if (file.fieldname === "extraConfig") ext = ".json";
      else if (file.fieldname === "cv" || file.originalname.toLowerCase().endsWith(".docx")) ext = ".docx";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
});
const app = express();
app.use("/out", express.static(OUT_ROOT));
app.use("/uploads", express.static(UPLOADS_ROOT));
app.use("/static", express.static(PUBLIC_ROOT));
app.use(downloadUrls);
app.use(editorUrls);

app.get("/", (_req, res) => {
  res.send(layout("Pipeline Design-to-Code", {
    crumb: `<span class="cur">Nouveau run</span>`,
    rail: runsRail(listRuns()),
    main: `<main class="canvas"><div class="canvas-pad canvas-center">
      <div style="margin-bottom: 24px; display: flex; gap: 8px;">
        <a href="/" class="btn primary">PDF ➔ HTML</a>
        <a href="/jinja" class="btn ghost">CV ➔ Docx (Jinja)</a>
      </div>
      <form id="uploadForm" class="sheet" action="/run" method="post" enctype="multipart/form-data">
        <div class="sheet-head">
          <div>
            <h2>Nouveau run</h2>
            <p>Un PDF entre, un composant React en sort. 5 passes : extraction, 3 tentatives, correctifs de taille.</p>
          </div>
        </div>

        <div class="sheet-body">
          <p class="sec"><span class="step-n">1</span>PDF source</p>
          <div id="dropzone">
            <div class="dz-inner">
              <span class="dz-icon">${ICON.file}</span>
              <div>
                <p class="big">Glisse un PDF ici</p>
                <p class="sub">ou clique pour en choisir un</p>
              </div>
            </div>
            <input type="file" name="pdf" accept="application/pdf" id="fileInput" hidden>
          </div>

          <div class="field-row">
            <label for="pageInput">Page à traiter<span class="hint">« all » pour tout le template, ou un numéro pour n'en faire qu'une.</span></label>
            <input type="text" class="num" name="page" id="pageInput" value="all" pattern="[0-9]+|all|ALL" title="Un numéro de page, ou all">
          </div>

          <div class="field-row">
            <label for="effortInput">Raisonnement de la passe 1<span class="hint">Plus haut = meilleure analyse, mais le raisonnement est facturé comme de la sortie.</span></label>
            <select class="num" name="effort" id="effortInput">
              <option value="low">low — rapide</option>
              <option value="high" selected>high — par défaut</option>
              <option value="max">max — template complexe</option>
            </select>
          </div>
        </div>

        <div class="sheet-head" style="border-top:1px solid var(--sheet-rule);border-bottom:none;align-items:center">
          <div>
            <h2><span class="step-n">2</span>extra_config<span style="font-weight:400;color:var(--sheet-tx-3)"> — optionnel</span></h2>
            <p>Schéma réel du template (CvParserConfig). Sans lui, un schéma générique est utilisé.</p>
          </div>
          <div class="tabs">
            <button type="button" class="tab-btn active" data-tab="file">Fichier</button>
            <button type="button" class="tab-btn" data-tab="paste">Coller</button>
          </div>
        </div>
        <div class="sheet-body" style="padding-top:0">
          <div class="tab-panel active" data-panel="file">
            <div id="extraConfigDrop">
              <span id="extraConfigDropLabel">Glisse un fichier .json ici ou clique pour en choisir un</span>
              <input type="file" name="extraConfig" accept="application/json,.json" id="extraConfigInput" hidden>
            </div>
          </div>
          <div class="tab-panel" data-panel="paste">
            <textarea id="extraConfigText" spellcheck="false" placeholder='{ "frontend_cvparser_config": [ ... ] }'></textarea>
            <div id="extraConfigStatus" role="status"></div>
          </div>
        </div>

        <div class="sheet-foot">
          <button type="submit" id="submitBtn" class="btn primary" disabled>${ICON.play}<span class="btn-label">Choisis d'abord un PDF</span></button>
        </div>
        <input type="hidden" name="extraConfigText" id="extraConfigTextHidden">
      </form>
    </div></main>`,
    script: `<script src="/static/home.js"></script>`,
  }));
});

app.get("/jinja", (_req, res) => {
  res.send(layout("CV ➔ Docx (Jinja)", {
    crumb: `<span class="cur">Nouveau run Jinja</span>`,
    rail: runsRail(listRuns()),
    main: `<main class="canvas"><div class="canvas-pad canvas-center">
      <div style="margin-bottom: 24px; display: flex; gap: 8px;">
        <a href="/" class="btn ghost">PDF ➔ HTML</a>
        <a href="/jinja" class="btn primary">CV ➔ Docx (Jinja)</a>
      </div>
      <form id="jinjaForm" class="sheet" action="/run-jinja" method="post" enctype="multipart/form-data">
        <div class="sheet-head">
          <div>
            <h2>Remplissage Jinja</h2>
            <p>Un CV entre, un Docx rempli en sort (via Kimi K3).</p>
          </div>
        </div>

        <div class="sheet-body">
          <p class="sec"><span class="step-n">1</span>Document CV (.docx)</p>
          <div id="dropzoneJinja" style="border: 2px dashed var(--sheet-rule); border-radius: 6px; padding: 32px; text-align: center; cursor: pointer; transition: all 0.2s;" class="dropzone">
            <div class="dz-inner" style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
              <span class="dz-icon" style="color: var(--sheet-tx-3);">${ICON.file}</span>
              <div>
                <p class="big" style="margin: 0; font-weight: 500;">Glisse un .docx ici</p>
                <p class="sub" style="margin: 0; color: var(--sheet-tx-2); font-size: 13px;">ou clique pour en choisir un</p>
              </div>
            </div>
            <input type="file" name="cv" accept=".docx" id="cvInput" hidden required>
          </div>
          <p class="hint" style="margin-top: 16px;">Fournissez un CV au format .docx rempli avec des données factices. Le système générera le template Jinja correspondant, les 2 prompts et l'extra-config.</p>
        </div>

        <div class="sheet-foot">
          <button type="submit" id="submitJinjaBtn" class="btn primary">${ICON.play}<span class="btn-label">Lancer la génération</span></button>
        </div>
      </form>
    </div></main>`,
    script: `<script>
      const form = document.getElementById('jinjaForm');
      const btn = document.getElementById('submitJinjaBtn');
      const dz = document.getElementById('dropzoneJinja');
      const input = document.getElementById('cvInput');

      function setDocx(file) {
        if (!file) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        dz.style.borderColor = 'var(--accent)';
        dz.style.backgroundColor = 'rgba(var(--accent-rgb), 0.05)';
        dz.querySelector('.dz-icon').style.color = 'var(--accent)';
        dz.querySelector('.big').textContent = file.name;
        dz.querySelector('.sub').textContent = (file.size / 1024 / 1024).toFixed(2) + ' Mo — prêt';
        btn.disabled = false;
        btn.querySelector('.btn-label').textContent = 'Lancer la génération';
      }

      dz.addEventListener('click', () => input.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.style.borderColor = 'var(--accent)'; });
      dz.addEventListener('dragleave', () => dz.style.borderColor = 'var(--sheet-rule)');
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.style.borderColor = 'var(--sheet-rule)';
        if (e.dataTransfer.files.length) setDocx(e.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => { if (input.files.length) setDocx(input.files[0]); });

      form.addEventListener('submit', () => {
        btn.disabled = true;
        btn.querySelector('.btn-label').textContent = 'Démarrage...';
      });
    </script>`,
  }));
});

app.post("/run-jinja", upload.fields([
  { name: "cv", maxCount: 1 }
]), (req, res) => {
  const cvFile = req.files?.cv?.[0];

  if (!cvFile) {
    return res.status(400).send("Fichier manquant.");
  }

  const runId = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const outDir = path.join(OUT_ROOT, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const state = {
    status: "running", step: "extract", message: "Démarrage...", log: [],
    stream: { step: null, kind: null, text: "" },
    result: null, error: null, pdfUrl: "/uploads/" + path.basename(cvFile.path), page: 1,
    type: "jinja"
  };
  runs.set(runId, state);

  runJinjaPipeline({
    cvPath: cvFile.path,
    outDir,
    onProgress: (step, message) => {
      state.step = step;
      state.message = message;
      state.log.push({ step, message });
    }
  }).then((result) => {
    state.status = "done";
    state.result = result;
    try {
      fs.writeFileSync(
        path.join(outDir, "run-meta.json"),
        JSON.stringify({
          type: "jinja",
          pdfUrl: state.pdfUrl,
          finishedAt: new Date().toISOString(),
        }, null, 2)
      );
    } catch { /* ignore */ }
  }).catch((err) => {
    state.status = "error";
    state.error = err.message;
  });

  res.redirect(303, `/runs/${runId}`);
});

app.post("/run", upload.fields([{ name: "pdf", maxCount: 1 }, { name: "extraConfig", maxCount: 1 }]), (req, res) => {
  const pdfFile = req.files?.pdf?.[0];
  if (!pdfFile) return res.status(400).send("PDF manquant.");
  const extraConfigFile = req.files?.extraConfig?.[0];
  // "all" = reproduire le template entier (toutes les pages du PDF).
  const rawPage = String(req.body.page || "all").trim().toLowerCase();
  const pageNumber = rawPage === "all" ? "all" : (parseInt(rawPage, 10) || 1);
  // Effort de raisonnement de la passe 1, choisi dans le formulaire.
  const rawEffort = String(req.body.effort || "high").trim().toLowerCase();
  const pass1Effort = ["low", "high", "max"].includes(rawEffort) ? rawEffort : "high";

  // extra_config peut venir soit d'un fichier uploadé, soit de JSON collé
  // dans le textarea (envoyé dans le champ caché extraConfigText) -- dans
  // ce 2e cas on l'écrit dans un fichier temporaire pour réutiliser
  // exactement le même chemin (extraConfigPath) côté runPipeline.
  let extraConfigPath = extraConfigFile?.path;
  const extraConfigText = (req.body.extraConfigText || "").trim();
  if (!extraConfigPath && extraConfigText) {
    try {
      JSON.parse(extraConfigText);
    } catch (err) {
      return res.status(400).send(`extra_config collé n'est pas un JSON valide : ${err.message}`);
    }
    extraConfigPath = path.join(UPLOADS_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(extraConfigPath, extraConfigText);
  }

  const runId = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const outDir = path.join(OUT_ROOT, runId);
  const state = {
    status: "running", step: "extract", message: "Démarrage...", log: [],
    stream: { step: null, kind: null, text: "" },
    result: null, error: null, pdfUrl: "/uploads/" + path.basename(pdfFile.path), page: pageNumber,
    effort: pass1Effort,
  };
  runs.set(runId, state);

  runPipeline({
    pdfPath: pdfFile.path,
    pageNumber,
    pass1Effort,
    extraConfigPath,
    outDir,
    onProgress: (step, message) => {
      state.step = step;
      state.message = message;
      state.log.push({ step, message });
    },
    onStream: (step, kind, text) => {
      state.stream = { step, kind, text };
    },
  })
    .then((result) => {
      state.status = "done";
      state.result = result;
      // Trace sur disque : permet de rouvrir ce run après un redémarrage du
      // serveur (les runs ne vivent qu'en mémoire autrement).
      try {
        fs.writeFileSync(
          path.join(outDir, "run-meta.json"),
          JSON.stringify({
            pdfUrl: state.pdfUrl,
            page: state.page,
            effort: state.effort,
            width: result.width,
            height: result.height,
            finishedAt: new Date().toISOString(),
            tokens: {
              totalInputTokens: result.totalInputTokens,
              totalOutputTokens: result.totalOutputTokens,
              totalCacheReadTokens: result.totalCacheReadTokens,
              totalCacheWriteTokens: result.totalCacheWriteTokens,
            },
            // Détail par passe : indispensable pour savoir laquelle coûte
            // cher plutôt que de l'estimer.
            perPass: result.perPassUsage,
            costUsd: (result.perPassUsage || []).reduce((sum, p) => sum + p.costUsd, 0),
          }, null, 2)
        );
      } catch { /* la trace est un confort, pas un prérequis */ }
    })
    .catch((err) => { state.status = "error"; state.error = err.message; });

  res.redirect(303, `/runs/${runId}`);
});

/** Applique dans le JSX les ajustements d'images faits à la souris, puis
 * re-rend. Le résultat écrase le .jsx de la dernière passe pour que le
 * téléchargement et la preview repartent du code corrigé. */

app.get("/runs/:id/status.json", (req, res) => {
  const state = getRun(req.params.id);
  if (!state) return res.status(404).json({ error: "run introuvable" });
  res.json({ status: state.status, step: state.step, message: state.message, log: state.log, stream: state.stream, error: state.error });
});

/** Écart entre les deux cadres dans le plan de travail, en pixels du document. */
const BOARD_GAP = 80;

app.get("/runs/:id", (req, res) => {
  const state = getRun(req.params.id);
  if (!state) return res.status(404).send("Run introuvable.");

  const runId = req.params.id;
  const crumb = `<a href="/">Runs</a><span>/</span><span class="idchip">${esc(runId)}</span>`;
  const backBtn = `<a class="btn ghost" href="/">${ICON.back}<span>Nouveau run</span></a>`;
  const backIcon = `<a class="btn ghost icon" href="/" title="Nouveau run" aria-label="Nouveau run">${ICON.back}</a>`;

  // ---------------------------------------------------------------- en cours
  if (state.status !== "done" && state.status !== "error") {
    return res.send(layout("Run en cours", {
      crumb,
      status: `<span class="badge running">En cours</span>`,
      actions: backBtn,
      rail: `<div class="rail-group">
          <p class="rail-title">Ce run</p>
          <dl class="kv">
            <div class="kv-row"><dt>Page</dt><dd>${state.page}</dd></div>
            ${state.effort ? `<div class="kv-row"><dt>Raisonnement</dt><dd>${esc(state.effort)}</dd></div>` : ""}
            <div class="kv-row"><dt>Démarré</dt><dd>${runWhen(runId)}</dd></div>
            <div class="kv-row"><dt>Écoulé</dt><dd id="elapsed">—</dd></div>
          </dl>
        </div>
        ${runsRail(listRuns(), runId)}`,
      // Deux colonnes : les étapes à gauche, ce que la machine dit à droite.
      // Tout tient dans la hauteur de la fenêtre, chaque panneau défile chez lui.
      main: `<main class="canvas"><div class="canvas-pad">
        <div class="run-grid">
          <div class="run-col">
            <div class="sheet">
              <div class="sheet-head">
                <div>
                  <h2>Génération en cours</h2>
                  <p>5 passes, dont 3 appels à Claude. Tu peux laisser cet onglet ouvert.</p>
                </div>
              </div>
              <div class="sheet-body" id="live">${renderStages(state.step, state.message, state.type)}</div>
            </div>
          </div>
          <div class="run-col">
            <div class="console-block" id="streambox-wrap" hidden>
              <p class="console-head"><span id="streambox-icon">${ICON.think}</span><span class="stream-live" id="streambox-label"></span></p>
              <pre class="console" id="streambox"></pre>
            </div>
            <div class="console-block">
              <p class="console-head">Journal</p>
              <pre class="console" id="logbox"></pre>
            </div>
          </div>
        </div>
      </div></main>`,
      script: `<script>window.CV_RUN=${JSON.stringify({
        runId,
        startedAt: parseInt(runId.split("-")[0], 10) || Date.now(),
        stageIds: (state.type === "jinja" ? JINJA_STAGES : STAGES).map((s) => s.id),
        stageNames: Object.fromEntries((state.type === "jinja" ? JINJA_STAGES : STAGES).map((s) => [s.id, s.name])),
        iconThink: ICON.think,
        iconWrite: ICON.write,
      })}</script><script src="/static/run_progress.js"></script>`,
    }));
  }

  // ------------------------------------------------------------------ erreur
  if (state.status === "error") {
    return res.send(layout("Erreur", {
      crumb,
      status: `<span class="badge error">Échec</span>`,
      actions: backBtn,
      rail: runsRail(listRuns(), runId),
      main: `<main class="canvas"><div class="canvas-pad canvas-center">
        <div class="sheet error-sheet">
          <div class="sheet-head">
            <div>
              <h2>Le run s'est arrêté</h2>
              <p>Rien n'a été écrasé. Relance depuis le même PDF, ou corrige l'extra_config d'abord.</p>
            </div>
            <span style="color:var(--bad);flex:none">${ICON.warn}</span>
          </div>
          <div class="sheet-body"><pre class="error-msg">${esc(state.error)}</pre></div>
          <div class="sheet-foot"><a class="btn primary" href="/" style="width:100%;height:32px">${ICON.play}<span>Nouveau run</span></a></div>
        </div>
      </div></main>`,
    }));
  }

  // --------------------------------------------------------------- résultat
  if (state.type === "jinja") {
    return res.send(layout("Résultat Jinja", {
      crumb,
      status: `<span class="badge done">Terminé</span>`,
      actions: `
        <a class="btn primary" href="/out/${runId}/result.docx" download>${ICON.download}<span>Télécharger le .docx</span></a>
        ${backIcon}`,
      rail: runsRail(listRuns(), runId),
      main: `<main class="canvas"><div class="canvas-pad canvas-center">
        <div class="sheet">
          <div class="sheet-head">
            <div>
              <h2>Assets générés avec succès</h2>
              <p>Le template Jinja, les prompts et la configuration ont été créés à partir du CV.</p>
            </div>
            <span style="color:var(--good);flex:none">${ICON.check || "✓"}</span>
          </div>
          <div class="sheet-body" style="display:flex; flex-direction:column; gap:8px;">
            <a class="btn primary" href="/out/${runId}/template.docx" download>${ICON.download}<span>Template Jinja (.docx)</span></a>
            <a class="btn ghost" href="/out/${runId}/global_prompt.md" download>${ICON.download}<span>Prompt Global (.md)</span></a>
            <a class="btn ghost" href="/out/${runId}/experience_prompt.md" download>${ICON.download}<span>Prompt Expériences (.md)</span></a>
            <a class="btn ghost" href="/out/${runId}/extra_config.json" download>${ICON.download}<span>Extra Config (.json)</span></a>
          </div>
        </div>
      </div></main>`,
    }));
  }

  const { result } = state;
  // La capture cible sert à la fois de cadre de gauche et de calque de
  // décalque. Pour un run encore en mémoire elle n'est pas dans l'état, on la
  // retrouve sur le disque.
  const targetForOnion = state.targetUrl || (() => {
    try {
      const stacked = stackedTarget(result.outDir);
      return stacked ? toPublicUrl(stacked) : null;
    } catch { return null; }
  })();
  const finalPass = result.passes.at(-1);
  const otherPasses = result.passes.slice(0, -1);
  const fmt = (n) => (n == null ? "—" : n.toLocaleString("fr-FR"));
  const passLabel = (p) => esc(p.label).replace(/ -- /g, " — ");
  const W = result.width, H = result.height;
  // Hauteurs RÉELLES des deux planches. Sur un run multi-pages elles
  // diffèrent de la hauteur d'une page -- et l'une de l'autre, puisque le
  // moteur de pagination émet autant de pages que les données l'exigent, pas
  // forcément autant que la cible en compte. Les figer à H écrasait la cible
  // empilée dans la hauteur d'une seule page.
  const pngHeight = (file) => {
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(24);
      fs.readSync(fd, buf, 0, 24, 0);
      fs.closeSync(fd);
      return buf.readUInt32BE(20) || null;
    } catch { return null; }
  };
  // Bandes de coupure : une par jointure entre deux pages, positionnée sur
  // les hauteurs réelles -- une page rendue ne fait pas forcément la hauteur
  // du canevas (contenu qui déborde), donc on ne peut pas les déduire.
  const PAGE_GAP = 24;
  const gapStrips = (heights) => heights.slice(0, -1)
    .map((_, i) => heights.slice(0, i + 1).reduce((a, b) => a + b, 0) + PAGE_GAP * i)
    .map((top) => `<div class="page-gap" style="top:${top}px;height:${PAGE_GAP}px"></div>`)
    .join("");
  const targetGaps = gapStrips(targetPages(result.outDir).map((f) => pngHeight(f) || H));
  const previewGaps = gapStrips(
    fs.readdirSync(result.outDir)
      .filter((f) => /^final-page-\d+\.png$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
      .map((f) => pngHeight(path.join(result.outDir, f)) || H)
  );

  const targetH = (targetForOnion && pngHeight(path.join(result.outDir, path.basename(targetForOnion)))) || H;
  const previewH = pngHeight(finalPass.pngPath) || H;
  const worldH = Math.max(targetH, previewH);

  // La capture cible fait exactement la taille du rendu : posées côte à côte à
  // la même échelle, les deux pages se comparent directement à l'oeil, et un
  // seul zoom vaut pour les deux. Le PDF d'origine reste accessible à part --
  // son lecteur intégré ne se laisse pas mettre à l'échelle proprement.
  const targetContent = targetForOnion
    ? `<img src="${targetForOnion}" alt="Capture de la page cible" draggable="false">`
    : state.pdfUrl
      ? `<embed src="${state.pdfUrl}${String(state.page).toLowerCase() === "all" ? "#toolbar=0" : `#page=${state.page}&toolbar=0`}" type="application/pdf">`
      : `<p class="empty">Cible indisponible.</p>`;

  res.send(layout("Résultat", {
    crumb,
    status: `<span class="badge done">Terminé</span>`,
    actions: `
      ${state.pdfUrl ? `<a class="btn ghost" href="${state.pdfUrl}${String(state.page).toLowerCase() === "all" ? "" : `#page=${state.page}`}" target="_blank" rel="noopener">${ICON.pdf}<span>PDF</span></a>` : ""}
      <a class="btn primary" href="/runs/${runId}/download">${ICON.download}<span>Télécharger le .jsx</span></a>
      ${backIcon}`,
    rail: `<div class="rail-group">
        <p class="rail-title">Passes</p>
        <ul class="passlist">
          ${otherPasses.map((p, i) => `<li><a href="${toPublicUrl(p.htmlPath)}" target="_blank" rel="noopener"><span class="n">${i + 1}</span>${passLabel(p)}</a></li>`).join("")}
          <li class="cur"><span><span class="n">${result.passes.length}</span>${passLabel(finalPass)}</span></li>
        </ul>
      </div>
      <div class="rail-group">
        <p class="rail-title">Ce run</p>
        <dl class="kv">
          <div class="kv-row"><dt>Page</dt><dd>${state.page}</dd></div>
          ${state.effort ? `<div class="kv-row"><dt>Raisonnement</dt><dd>${esc(state.effort)}</dd></div>` : ""}
          <div class="kv-row"><dt>Taille</dt><dd>${W}×${H}</dd></div>
          ${result.totalInputTokens != null ? `
            <div class="kv-row"><dt>Tokens in</dt><dd>${fmt(result.totalInputTokens)}</dd></div>
            <div class="kv-row"><dt>Tokens out</dt><dd>${fmt(result.totalOutputTokens)}</dd></div>
            ${result.totalCacheReadTokens || result.totalCacheWriteTokens ? `
              <div class="kv-row"><dt>Cache lu</dt><dd>${fmt(result.totalCacheReadTokens)}</dd></div>
              <div class="kv-row"><dt>Cache écrit</dt><dd>${fmt(result.totalCacheWriteTokens)}</dd></div>` : ""}
          ` : `<div class="kv-row"><dt>Origine</dt><dd>disque</dd></div>`}
        </dl>
      </div>
      ${runsRail(listRuns(), runId)}`,
    main: `<main class="viewport" id="viewport">
      <div class="world" id="world" style="width:${W * 2 + BOARD_GAP}px;height:${worldH}px">
        <div class="board" id="targetPane" style="left:0;width:${W}px;height:${targetH}px">
          <p class="frame-name">${state.pdfUrl ? "PDF cible" : "Capture cible"}<span class="fn-sub">${String(state.page).toLowerCase() === "all" ? `${targetPages(result.outDir).length} pages` : `page ${state.page}`}</span></p>
          ${targetContent}
          ${targetGaps}
          <div class="board-shield"></div>
        </div>
        <div class="board" id="previewPane" style="left:${W + BOARD_GAP}px;width:${W}px;height:${previewH}px">
          <p class="frame-name">${passLabel(finalPass)}<span class="fn-sub">rendu live</span></p>
          <iframe id="scaleFrame" title="Preview du composant généré" src="${toPublicUrl(finalPass.htmlPath)}" width="${W}" height="${previewH}" scrolling="no"></iframe>
          ${previewGaps}
          <div class="board-shield"></div>
        </div>
      </div>
      <div class="dock" role="toolbar" aria-label="Outils">
        <button type="button" class="tool" data-tool="none" aria-pressed="true" title="Parcourir — H">${ICON.hand}</button>
        <button type="button" class="tool" data-tool="all" aria-pressed="false" title="Sélection — V">${ICON.cursor}</button>
        <button type="button" class="tool" data-tool="text" aria-pressed="false" title="Texte — T">${ICON.text}</button>
        <button type="button" class="tool" data-tool="img" aria-pressed="false" title="Image — I">${ICON.image}</button>
        <button type="button" class="tool" data-tool="div" aria-pressed="false" title="Bloc (conteneur) — B">${ICON.block}</button>
        <span class="zsep"></span>
        <button type="button" id="onionBtn" aria-pressed="false" title="Calque de la cible — O"${targetForOnion ? "" : " disabled"}>${ICON.onion}</button>
        <span class="zsep"></span>
        <button type="button" id="zOut" title="Dézoomer" aria-label="Dézoomer">${ICON.minus}</button>
        <button type="button" id="zVal" class="zval" title="Revenir à 100 %">100 %</button>
        <button type="button" id="zIn" title="Zoomer" aria-label="Zoomer">${ICON.plus}</button>
        <button type="button" id="zFit" title="Tout afficher — Maj+1" aria-label="Tout afficher">${ICON.fit}</button>
      </div>
      <p class="zoomhint">
        <kbd>glisser</kbd> déplacer &nbsp; <kbd>molette</kbd> défiler &nbsp;
        <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>molette</kbd> zoomer &nbsp; <kbd>Espace</kbd>+glisser
      </p>
    </main>`,
    inspector: `<aside id="editSidebar" aria-label="Ajuster les images">
      <h3>Ajuster</h3>
      <div>
        <p class="sb-label">Sélection</p>
        <div class="sb-box" id="sbSel"><div class="sb-row"><span>Aucune</span></div></div>
      </div>
      ${targetForOnion ? `<div id="sbOnion" hidden>
        <p class="sb-label">Calque de la cible</p>
        <div class="sb-box">
          <input type="range" id="onionOpacity" min="0" max="100" value="45" aria-label="Opacité du calque" style="margin-top:0">
          <div class="sb-row"><span>Opacité</span><span id="onionVal">45 %</span></div>
        </div>
      </div>` : ""}
      <div id="sbSpacing" hidden>
        <p class="sb-label">Espacement</p>
        <div class="sb-box">
          <div style="display:flex;gap:4px;margin-bottom:8px">
            <button type="button" class="sb-btn mode-btn active" data-mode="padding">Intérieur (P)</button>
            <button type="button" class="sb-btn mode-btn" data-mode="margin">Extérieur (M)</button>
          </div>
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Haut</span><input type="number" step="0.1" class="pad-in" data-side="n" aria-label="Haut"></div>
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Droite</span><input type="number" step="0.1" class="pad-in" data-side="e" aria-label="Droite"></div>
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Bas</span><input type="number" step="0.1" class="pad-in" data-side="s" aria-label="Bas"></div>
          <div class="sb-row scrubbable" title="Glisser la souris ou utiliser la molette"><span>Gauche</span><input type="number" step="0.1" class="pad-in" data-side="w" aria-label="Gauche"></div>
        </div>
      </div>
      <div>
        <p class="sb-label">Raccourcis</p>
        <div class="sb-keys">
          <kbd>glisser</kbd> déplacer<br>
          <kbd>poignées</kbd> redimensionner<br>
          <kbd>Maj</kbd> + poignée : centre fixe<br>
          <kbd>←↑↓→</kbd> 1 px &nbsp; <kbd>Maj</kbd>+flèches 10 px<br>
          <kbd>P</kbd> marge intérieure &nbsp; <kbd>M</kbd> extérieure<br>
          <kbd>Ctrl</kbd>+<kbd>Z</kbd> annuler &nbsp; <kbd>Ctrl</kbd>+<kbd>Y</kbd> rétablir<br>
          <kbd>Échap</kbd> désélectionner
        </div>
      </div>
      <div class="sb-actions">
        <p class="sb-status" id="sbStatus">Aucune modification</p>
        <button type="button" id="editSave" class="sb-btn primary" disabled>Enregistrer</button>
        <button type="button" id="editCancel" class="sb-btn">Annuler et quitter</button>
      </div>
    </aside>`,
    script: `<script>window.CV_RUN=${JSON.stringify({
      runId, W, H, worldH, previewH,
      worldW: W * 2 + BOARD_GAP,
      boardOffset: W + BOARD_GAP,
      target: targetForOnion,
    })}</script><script src="/static/run_view.js"></script>`,
  }));
});

const PORT = process.env.PIPELINE_PORT || 5050;
app.listen(PORT, () => console.log(`Interface pipeline sur http://localhost:${PORT}`));
