from pathlib import Path

from playwright.sync_api import sync_playwright

# width/height DOIVENT etre le CANVAS_W/CANVAS_H reel (la taille de l'image
# cible) -- le composant se mesure lui-meme via ResizeObserver et se reduit
# s'il est charge dans un viewport plus etroit, ce qui fausserait toute
# comparaison avec le dictionnaire (echelle cible).

MEASURE_TITLES_JS = """(strings) => {
  const out = {};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.replace(/\\s+/g, " ").trim();
    if (!text) continue;
    const upper = text.toUpperCase();
    if (strings.includes(upper) && !(upper in out)) {
      const el = node.parentElement;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size > 0) out[upper] = size;
    }
  }
  return out;
}"""

MEASURE_TEXTS_JS = """() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.replace(/\\s+/g, " ").trim();
    if (!text || text.length > 60) continue;
    const el = node.parentElement;
    if (!el || typeof el.className !== "string" || !el.className) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (!(size > 0)) continue;
    out.push({ text, fontSizePx: size, className: el.className });
  }
  return out;
}"""


def measure_dom_sizes(html_file: Path, search_strings: list[str], width: int, height: int) -> dict[str, float]:
    """Passe 4 (algorithmique) -- mesure la taille REELLEMENT rendue
    (getComputedStyle) des memes textes de titres statiques que
    measure_dictionary, pour comparaison."""
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(f"file://{Path(html_file).resolve()}", wait_until="networkidle")
            return page.evaluate(MEASURE_TITLES_JS, search_strings)
        finally:
            browser.close()


def measure_dom_texts(html_file: Path, width: int, height: int) -> list[dict]:
    """Passe 5 (algorithmique) -- dump TOUS les textes rendus avec leur
    taille de police calculee ET la className de leur element parent, pour
    regrouper par composant partage."""
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(f"file://{Path(html_file).resolve()}", wait_until="networkidle")
            return page.evaluate(MEASURE_TEXTS_JS)
        finally:
            browser.close()
