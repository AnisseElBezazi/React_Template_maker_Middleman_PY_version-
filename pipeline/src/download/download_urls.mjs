// Point d'entrée des routes de téléchargement.

import { Router } from "express";
import { downloadRun } from "./download_controller.mjs";

export const downloadUrls = Router();
downloadUrls.get("/runs/:id/download", downloadRun);
