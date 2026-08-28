// Point d'entrée des routes de l'éditeur visuel.

import express, { Router } from "express";
import { rerenderRun, editorOverlay, applyEdits } from "./editor_controller.mjs";

export const editorUrls = Router();
editorUrls.post("/runs/:id/rerender", rerenderRun);
editorUrls.get("/editor-overlay.js", editorOverlay);
editorUrls.post("/runs/:id/image-edits", express.json({ limit: "1mb" }), applyEdits);
