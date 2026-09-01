<div align="center">

# CV Smart · Design-to-Code

**Transforme le design d'un CV (PDF ou DOCX) en composant React prêt à brancher, ou en template Jinja prêt à remplir.**

![Python](https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-3.4-06B6D4?logo=tailwindcss&logoColor=white)
![Kimi](https://img.shields.io/badge/LLM-Kimi%20K3.1%20Pro-111827)

</div>

---

Chaque cabinet de conseil a son propre gabarit de dossier de compétences. Reproduire ce gabarit à la main en React, avec
la pagination, les marges, les puces, les images de fond, prend des heures. **CV Smart Design-to-Code** automatise ce travail :
on dépose le gabarit, un modèle de langage multimodal le reconstruit, se compare à la cible pixel par pixel, puis s'auto-corrige.

Le résultat est un composant `<Nom>TemplateHtml({ cvData, assets })` qui réutilise le moteur de pagination du produit
(`PaginatedEntryPages`, `splitEntryIntoFragments`) et un export zip au format attendu par l'application cible.

## Fonctionnalités

- **PDF → React** : extraction du PDF, génération du JSX en plusieurs passes, auto-correction visuelle, correction d'échelle et de tailles.
- **DOCX → Jinja** : un template Word est balisé pour `docxtpl` (variables, boucles, conditions) à partir d'un CV exemple, avec la configuration et les prompts d'extraction associés.
- **Conversion DOCX → PDF automatique** : un `.docx` déposé dans l'interface est converti en PDF (LibreOffice) avant d'entrer dans la pipeline.
- **Pagination réelle** : le composant généré passe par le même moteur de pagination que la production, il déborde donc proprement sur plusieurs pages.
- **Éditeur visuel** : déplacer, redimensionner, retoucher les images et les textes directement sur le rendu.
- **Édition en langage naturel** : un panneau de chat applique une modification précise au JSX sans régénérer le template.
- **Suivi des coûts** : tokens et coût estimé de chaque passe, avec le cache de prompt pris en compte.
- **Annulation** : un run peut être arrêté à tout moment, y compris en plein appel au modèle.
- **Export** : archive zip avec le composant, le CSS Tailwind compilé et scopé, et les images.

