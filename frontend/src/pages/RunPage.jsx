import { useParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import Toolbar from "../components/Toolbar";
import RunsRail from "../components/RunsRail";
import Board from "../components/Board";
import Dock from "../components/Dock";
import EditSidebar from "../components/EditSidebar";
import StagesList from "../components/StagesList";
import JinjaDoneView from "./JinjaDoneView";
import RunConsole from "../components/RunConsole";
import RunInfoBox, { KvRow } from "../components/RunInfoBox";
import PassesList from "../components/PassesList";
import ChatPanel from "../components/ChatPanel";
import { IconBack, IconChat, IconClose, IconDownload, IconPdf, IconWarn } from "../components/Icons";
import { useRun } from "../hooks/useRun";
import { useRuns } from "../hooks/useRuns";
import { useViewport } from "../hooks/useViewport";
import { useEditor, isEditTool } from "../hooks/useEditor";
import { useElapsed } from "../hooks/useElapsed";
import { formatWhen } from "../hooks/formatWhen";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { cancelRun } from "../api/runs_api";

// Ecart entre les deux cadres dans le plan de travail, en pixels du document.
const BOARD_GAP = 80;

const fmt = (n) => (n == null ? "—" : n.toLocaleString("fr-FR"));

function RunningView({ run, runId }) {
  const isJinja = run.type === "jinja";
  return (
    <main className="canvas"><div className="canvas-pad">
      <div className="run-grid">
        <div className="run-col">
          <div className="sheet">
            <div className="sheet-head">
              <div>
                <h2>Génération en cours</h2>
                <p>{isJinja ? "3 passes, via Kimi K3.1 Pro. Tu peux laisser cet onglet ouvert."
                            : "5 passes, dont des appels au modèle. Tu peux laisser cet onglet ouvert."}</p>
              </div>
            </div>
            <div className="sheet-body" id="live"><StagesList currentStep={run.step} message={run.message} type={run.type} /></div>
          </div>
        </div>
        <div className="run-col">
          <RunConsole log={run.log} stream={run.stream} />
        </div>
      </div>
    </div></main>
  );
}

function ErrorView({ run }) {
  return (
    <main className="canvas"><div className="canvas-pad canvas-center">
      <div className="sheet error-sheet">
        <div className="sheet-head">
          <div>
            <h2>Le run s'est arrêté</h2>
            <p>Rien n'a été écrasé. Relance depuis le même PDF, ou corrige l'extra_config d'abord.</p>
          </div>
          <span style={{ color: "var(--bad)", flex: "none" }}><IconWarn /></span>
        </div>
        <div className="sheet-body"><pre className="error-msg">{run.error}</pre></div>
      </div>
    </div></main>
  );
}

function CancelledView() {
  return (
    <main className="canvas"><div className="canvas-pad canvas-center">
      <div className="sheet">
        <div className="sheet-head">
          <div>
            <h2>Run annulé</h2>
            <p>Arrêté avant la fin, à ta demande. Rien n'a été écrasé -- relance quand tu veux.</p>
          </div>
        </div>
      </div>
    </div></main>
  );
}

function RunningSidebarInfo({ run, runId }) {
  const elapsed = useElapsed(runId);
  return (
    <RunInfoBox>
      <KvRow label="Page" value={run.page} />
      {run.effort && <KvRow label="Raisonnement" value={run.effort} />}
      <KvRow label="Démarré" value={formatWhen(runId)} />
      <KvRow label="Écoulé" value={elapsed} />
    </RunInfoBox>
  );
}

function DoneSidebarInfo({ run }) {
  const r = run.result;
  const isJinja = run.type === "jinja";
  return (
    <RunInfoBox>
      {!isJinja && <KvRow label="Page" value={run.page} />}
      {run.effort && <KvRow label="Raisonnement" value={run.effort} />}
      {r.width != null && <KvRow label="Taille" value={`${r.width}×${r.height}`} />}
      {run.cost_usd != null && <KvRow label="Coût" value={`$${run.cost_usd.toFixed(4)}`} />}
      {r.total_input_tokens != null ? (
        <>
          <KvRow label="Tokens in" value={fmt(r.total_input_tokens)} />
          <KvRow label="Tokens out" value={fmt(r.total_output_tokens)} />
          {(r.total_cache_read_tokens || r.total_cache_write_tokens) && (
            <KvRow label="Cache lu" value={fmt(r.total_cache_read_tokens)} />
          )}
        </>
      ) : (
        <KvRow label="Origine" value="disque" />
      )}
    </RunInfoBox>
  );
}

function DoneView({ run, runId, chatOpen, onToggleChat }) {
  const r = run.result;
  const worldW = r.width * 2 + BOARD_GAP;
  const frameRef = useRef(null);
  const finalPass = r.passes[r.passes.length - 1];

  const { viewportRef, transform, panning, zoomPercent, fitAll, fitPreview, zoomBy, resetZoom, onWheelForFrame, handlers } = useViewport({
    worldWidth: worldW,
    worldHeight: r.world_height,
    focusWidth: r.width,
    focusHeight: r.preview_height,
    focusOffsetX: r.width + BOARD_GAP,
    onTool: (t) => editor.setTool(t),
    onOnionToggle: () => editor.setOnion(!editor.onionOn, run.target_url),
  });

  const editor = useEditor({ runId, frameRef, onFocusPreview: fitPreview });
  const editing = isEditTool(editor.tool);

  // Classes globales pilotees par le mode d'edition, comme dans l'ancienne
  // interface : elles gouvernent le curseur, l'assourdissement de la cible
  // et la largeur reservee au panneau lateral (voir styles.css).
  useEffect(() => {
    document.body.classList.toggle("tool-edit", editing);
    const pending = editor.pendingCount > 0;
    document.body.classList.toggle("editing-open", editing || editor.onionOn || pending);
    return () => {
      document.body.classList.remove("tool-edit", "editing-open");
    };
  }, [editing, editor.onionOn, editor.pendingCount]);

  // Desselectionner en cliquant hors de la preview / du panneau / du dock.
  useEffect(() => {
    const onPointerDown = (e) => {
      if (e.target.closest("#scaleFrame, #editSidebar, .dock")) return;
      const win = frameRef.current?.contentWindow;
      if (win) win.postMessage({ type: "cv-deselect" }, "*");
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Ctrl+Z / Ctrl+Y frappes sur la page parente (juste apres un clic sur un
  // bouton) sont relayees a l'iframe, qui detient l'historique.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!editing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); (e.shiftKey ? editor.redo : editor.undo)(); }
      else if (k === "y") { e.preventDefault(); editor.redo(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing, editor]);

  // La molette doit aussi marcher au-dessus de la preview en mode edition --
  // l'iframe est de meme origine, on ecoute directement dans son document.
  const bindFrameEvents = () => {
    try {
      const d = frameRef.current?.contentDocument;
      if (!d || d.__vpBound) return;
      d.__vpBound = true;
      d.addEventListener("wheel", (e) => {
        const rect = frameRef.current.getBoundingClientRect();
        onWheelForFrame(e, rect.left, rect.top);
      }, { passive: false });
    } catch { /* cross-origin, ne devrait pas arriver ici */ }
  };

  const showSidebar = editing || editor.onionOn || editor.pendingCount > 0;

  return (
    <>
      <main className={`viewport${panning ? " panning" : ""}`} ref={viewportRef} {...handlers}>
        <div className="world" style={{
          width: worldW, height: r.world_height,
          transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.z})`,
        }}>
          <Board id="targetPane" left={0} width={r.width} height={r.target_height}
            label={run.pdf_url ? "PDF cible" : "Capture cible"}
            sublabel={String(run.page).toLowerCase() === "all" ? `${r.page_count} pages` : `page ${run.page}`}
            pageHeights={r.target_page_heights}>
            {run.target_url
              ? <img src={run.target_url} alt="Capture de la page cible" draggable="false" />
              : <p className="empty">Cible indisponible.</p>}
          </Board>
          <Board id="previewPane" left={r.width + BOARD_GAP} width={r.width} height={r.preview_height}
            label={finalPass.label} sublabel="rendu live" pageHeights={r.preview_page_heights} className={editing ? "editing" : ""}>
            <iframe ref={frameRef} title="Preview du composant généré" src={finalPass.html_url}
              width={r.width} height={r.preview_height} scrolling="no" onLoad={bindFrameEvents} />
          </Board>
        </div>
        <div className="dock-row">
          <Dock tool={editor.tool} onToolChange={editor.setTool}
            onionOn={editor.onionOn} onionAvailable={!!run.target_url}
            onOnionToggle={() => editor.setOnion(!editor.onionOn, run.target_url)}
            zoomPercent={zoomPercent} onZoomIn={() => zoomBy(1.25)} onZoomOut={() => zoomBy(1 / 1.25)}
            onFit={() => fitAll()} onZoomReset={resetZoom} />
          <div className="dock">
            <button type="button" aria-pressed={chatOpen} title="Modifier par chat" onClick={onToggleChat}>
              <IconChat />
            </button>
          </div>
        </div>
        <p className="zoomhint">
          <kbd>glisser</kbd> déplacer &nbsp; <kbd>molette</kbd> défiler &nbsp;
          <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>molette</kbd> zoomer &nbsp; <kbd>Espace</kbd>+glisser
        </p>
      </main>
      <EditSidebar editor={editor} hasTarget={run.target_url} open={showSidebar} />
    </>
  );
}

const backBtn = <a className="btn ghost" href="/"><IconBack /><span>Nouveau run</span></a>;

export default function RunPage() {
  const { runId } = useParams();
  const { run, error } = useRun(runId);
  const runs = useRuns();
  const [cancelling, setCancelling] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useDocumentTitle(
    !run ? "Design-to-Code"
    : run.status === "running" ? "Run en cours"
    : run.status === "error" ? "Erreur"
    : run.status === "cancelled" ? "Annulé"
    : run.type === "jinja" ? "Résultat Jinja"
    : "Résultat"
  );

  if (error) return <p className="error-msg">{error}</p>;
  if (!run) return <p>Chargement...</p>;

  async function handleCancel() {
    setCancelling(true);
    try {
      await cancelRun(runId);
    } catch {
      setCancelling(false);
    }
  }

  const status = {
    running: <span className="badge running">En cours</span>,
    error: <span className="badge error">Échec</span>,
    cancelled: <span className="badge cancelled">Annulé</span>,
    done: <span className="badge done">Terminé</span>,
  }[run.status];

  const isJinja = run.type === "jinja";

  const actions = run.status === "done" ? (
    isJinja ? (
      <a className="btn primary" href={run.result.template_url} download><IconDownload /><span>Télécharger le .docx</span></a>
    ) : (
      <>
        {run.pdf_url && (
          <a className="btn ghost" href={`${run.pdf_url}${String(run.page).toLowerCase() === "all" ? "" : `#page=${run.page}`}`}
            target="_blank" rel="noopener noreferrer"><IconPdf /><span>PDF</span></a>
        )}
        <a className="btn primary" href={`/api/runs/${runId}/download`}><IconDownload /><span>Télécharger le .jsx</span></a>
      </>
    )
  ) : run.status === "running" ? (
    <button type="button" className="btn ghost" onClick={handleCancel} disabled={cancelling}>
      <IconClose /><span>{cancelling ? "Annulation..." : "Annuler"}</span>
    </button>
  ) : backBtn;

  return (
    <>
      <Toolbar
        crumb={<><a href="/">Runs</a><span>/</span><span className="idchip">{runId}</span></>}
        status={status}
        actions={actions}
      />
      <div className="workbench">
        <aside className="rail">
          {run.status === "done" && !isJinja && <PassesList passes={run.result.passes} />}
          {run.status === "done" && <DoneSidebarInfo run={run} />}
          {run.status !== "done" && <RunningSidebarInfo run={run} runId={runId} />}
          <RunsRail runs={runs} currentId={runId} />
        </aside>
        {run.status === "running" && <RunningView run={run} runId={runId} />}
        {run.status === "error" && <ErrorView run={run} />}
        {run.status === "cancelled" && <CancelledView />}
        {run.status === "done" && isJinja && <JinjaDoneView result={run.result} effort={run.effort} runId={runId} />}
        {run.status === "done" && !isJinja && (
          <DoneView run={run} runId={runId} chatOpen={chatOpen} onToggleChat={() => setChatOpen((o) => !o)} />
        )}
      </div>
      {run.status === "done" && !isJinja && (
        <ChatPanel runId={runId} open={chatOpen} onClose={() => setChatOpen(false)} />
      )}
    </>
  );
}
