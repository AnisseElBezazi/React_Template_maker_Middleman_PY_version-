import base64
import html
import re
import statistics
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

INVISIBLE_TEXT_DPI = 150

HEADING_KEYWORDS = {
    "header": ["CONTACT", "PROFIL", "PROFILE", "SUMMARY", "A PROPOS", "À PROPOS", "ABOUT"],
    "experiences": ["EXPERIENCE", "EXPÉRIENCE", "PARCOURS", "WORK EXPERIENCE"],
    "competences": ["COMPETENCE", "COMPÉTENCE", "TECHNIQUES", "SKILLS"],
    "formations": ["FORMATION", "EDUCATION", "ÉDUCATION"],
    "langues": ["LANGUE", "LANGUAGE"],
    "centres_interet": ["CENTRE D'INTERET", "CENTRES D'INTERET", "INTERESTS", "HOBBIES"],
    "projets": ["PROJET", "PROJECT"],
    "achievements": ["ACHIEVEMENT", "REALISATION", "RÉALISATION"],
}

BLOCK_TITLES = {
    "header": "En-tête",
    "experiences": "Aperçu des expériences",
    "competences": "Compétences",
    "formations": "Formations",
    "langues": "Langues",
    "centres_interet": "Centres d'intérêt",
    "projets": "Projets",
    "achievements": "Réalisations",
    "section": "Section Contenu",
}

ACCENT_COLOR = "#3B82F6"

BOLD_RE = re.compile(r"^\s*<b>(.*)</b>\s*$", re.DOTALL)
ITALIC_RE = re.compile(r"^\s*<i>(.*)</i>\s*$", re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
CSS_CLASS_RE = re.compile(r"\.(ft\d+)\{([^}]*)\}")
P_RUN_RE = re.compile(
    r'<p style="position:absolute;top:(\d+)px;left:(\d+)px;[^"]*"\s*class="(ft\d+)">(.*?)</p>',
    re.DOTALL,
)
PAGE_DIV_RE = re.compile(r'width:(\d+)px;height:(\d+)px;"\s*>\s*<img')


def classify(text):
    upper = text.upper().strip()
    for block_id, keywords in HEADING_KEYWORDS.items():
        for kw in keywords:
            if kw in upper:
                return block_id
    return "section"


def clean_font_family(raw_family):
    # pdftohtml prefixes subset fonts like "AAAAAC+Aptos"
    name = re.sub(r"^[A-Z]{6}\+", "", raw_family or "")
    name = name.replace("-", " ").strip()
    return name or "sans-serif"


def font_style_from_family(raw_family):
    lower = (raw_family or "").lower()
    weight = "bold" if "bold" in lower else ("300" if "light" in lower else "normal")
    style = "italic" if "italic" in lower else "normal"
    return weight, style


def run_pdftohtml_complex(pdf_path, out_dir, first_page=None, last_page=None, zoom=None):
    """pdftohtml's complex mode (-c) renders one background image per page
    (capturing vector shapes, gradients and every image already composited
    with its soft mask -- things the plain text/xml pass can't give us) and,
    separately, one <p> per distinct font/color run with its own CSS class.
    That per-run granularity is what makes colors reliable: a line that
    changes color midway (e.g. a colored keyword inside a black sentence)
    becomes several correctly-colored <p> tags instead of being flattened to
    a single color. first_page/last_page restrict the run to a page range
    (e.g. the single page a design-to-code test targets) instead of
    rasterizing/parsing the whole document for a result only one page of
    which will ever be used. zoom overrides pdftohtml's own default output
    scale (~108dpi-equivalent) -- needed whenever the caller must line this
    output up pixel-for-pixel against an image rendered at a different DPI
    (e.g. pdftoppm), otherwise every position/font-size here is off by a
    constant ratio relative to that image."""
    prefix = out_dir / "page"
    range_args = []
    if first_page is not None:
        range_args += ["-f", str(first_page)]
    if last_page is not None:
        range_args += ["-l", str(last_page)]
    if zoom is not None:
        range_args += ["-zoom", str(zoom)]
    result = subprocess.run(
        ["pdftohtml", "-c", "-q", *range_args, str(pdf_path), str(prefix)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pdftohtml a échoué: {result.stderr.strip()}")

    pages = []
    for f in sorted(out_dir.glob("page-*.html")):
        m = re.search(r"page-(\d+)\.html$", f.name)
        if m:
            pages.append(int(m.group(1)))
    if not pages:
        raise RuntimeError("pdftohtml n'a produit aucune page.")
    return sorted(pages)


def render_full_page_images(pdf_path, out_dir, dpi=INVISIBLE_TEXT_DPI, first_page=None, last_page=None):
    """Rasterize every page exactly as a real PDF viewer would (unlike the
    -c background, this bakes text in too). Used only to check whether a
    piece of extracted text actually has visible ink -- some PDFs contain
    text painted with an invisible render mode (hidden/OCR layers, leftover
    design elements) that text-extraction tools pull out anyway."""
    prefix = out_dir / "full"
    range_args = []
    if first_page is not None:
        range_args += ["-f", str(first_page)]
    if last_page is not None:
        range_args += ["-l", str(last_page)]
    result = subprocess.run(
        ["pdftoppm", "-png", "-r", str(dpi), *range_args, str(pdf_path), str(prefix)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return {}

    images = {}
    for f in out_dir.glob("full-*.png"):
        m = re.search(r"full-(\d+)\.png$", f.name)
        if m:
            images[int(m.group(1))] = Image.open(f).convert("L")
    return images


def drop_invisible_runs(runs, page_image, page_width):
    """A run has visible ink if its bounding box isn't perfectly flat in the
    real render -- invisible text leaves zero pixel variation since nothing
    was ever painted there, regardless of what color it claims."""
    if page_image is None:
        return runs
    scale = page_image.width / page_width
    visible = []
    for r in runs:
        x0 = max(0, int(r["left"] * scale))
        y0 = max(0, int(r["top"] * scale))
        x1 = min(page_image.width, int((r["left"] + r["width"]) * scale) + 1)
        y1 = min(page_image.height, int((r["top"] + r["height"]) * scale) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        extrema = page_image.crop((x0, y0, x1, y1)).getextrema()
        if extrema[1] - extrema[0] > 8:
            visible.append(r)
    return visible


def parse_css_classes(html_text):
    classes = {}
    for class_name, body in CSS_CLASS_RE.findall(html_text):
        props = dict(re.findall(r"([a-z-]+):([^;]+);", body))
        raw_family = props.get("font-family", "")
        size = float(props.get("font-size", "12px").rstrip("px"))
        classes[class_name] = {
            "size": size,
            "line_height": float(props["line-height"].rstrip("px")) if "line-height" in props else size * 1.2,
            "family": clean_font_family(raw_family),
            "raw_family": raw_family,
            "color": props.get("color", "#000000"),
        }
    return classes


def parse_runs(html_text, css_classes):
    """A single <p> can bundle several visual lines joined by <br/> when
    they share identical styling (pdftohtml -c doesn't emit a separate <p>
    per line unless the font/color changes). Splitting on <br/> and walking
    down by the class's own line-height keeps each line at its real position
    instead of collapsing them all onto the first line's coordinates."""
    default_spec = {"size": 12, "line_height": 14.4, "family": "sans-serif", "raw_family": "", "color": "#000000"}
    runs = []
    for top, left, class_name, content in P_RUN_RE.findall(html_text):
        spec = css_classes.get(class_name, default_spec)
        base_weight, base_style = font_style_from_family(spec["raw_family"])

        for i, segment in enumerate(re.split(r"<br\s*/?>", content)):
            weight, style = base_weight, base_style
            inner = segment
            bold_match = BOLD_RE.match(inner)
            if bold_match:
                weight = "bold"
                inner = bold_match.group(1)
            italic_match = ITALIC_RE.match(inner)
            if italic_match:
                style = "italic"
                inner = italic_match.group(1)

            text_plain = html.unescape(TAG_RE.sub("", segment)).replace("\xa0", " ").strip()
            if not text_plain:
                continue

            runs.append({
                "top": float(top) + i * spec["line_height"],
                "left": float(left),
                "size": spec["size"],
                "family": spec["family"],
                "color": spec["color"],
                "weight": weight,
                "style": style,
                "bold": weight == "bold",
                "text_plain": text_plain,
                "html": segment,
            })
    return runs


def estimate_geometry(runs):
    """-c mode gives each run's top-left corner but not its width, so we
    infer it from the next run sharing the same visual line (small top
    differences of a couple pixels are normal jitter, not a new line)."""
    lines = []
    for r in sorted(runs, key=lambda r: r["top"]):
        for line in lines:
            if abs(line[0]["top"] - r["top"]) <= 3:
                line.append(r)
                break
        else:
            lines.append([r])

    for line in lines:
        line.sort(key=lambda r: r["left"])
        for i, r in enumerate(line):
            # Character-count estimate approximates this run's own glyph
            # width. The gap to the next run on the line is only used as a
            # ceiling so a wide fallback-font estimate can't eat into (or
            # past) neighbouring text -- using that gap as the primary
            # target instead would force-fill the natural inter-word space
            # too, making adjacent words visually collide.
            estimate = max(1.0, len(r["text_plain"]) * r["size"] * 0.55)
            if i + 1 < len(line):
                estimate = min(estimate, max(1.0, line[i + 1]["left"] - r["left"]))
            r["width"] = estimate
            r["height"] = r["size"] * 1.25


def cluster_columns(lines, page_width):
    if len(lines) < 4:
        return [lines]
    lefts = sorted(l["left"] for l in lines)
    gaps = [(lefts[i + 1] - lefts[i], lefts[i], lefts[i + 1]) for i in range(len(lefts) - 1)]
    if not gaps:
        return [lines]
    biggest_gap, a, b = max(gaps, key=lambda g: g[0])
    if biggest_gap > page_width * 0.08 and biggest_gap > 40:
        split = (a + b) / 2
        left_col = [l for l in lines if l["left"] < split]
        right_col = [l for l in lines if l["left"] >= split]
        if left_col and right_col:
            return [left_col, right_col]
    return [lines]


def group_into_blocks(lines):
    lines = sorted(lines, key=lambda l: l["top"])
    median_height = statistics.median(l["height"] for l in lines)
    blocks = []
    current = []
    prev_bottom = None

    def is_heading(line):
        text = line["text_plain"].strip()
        if not text or len(text) >= 40:
            return False
        return classify(text) != "section" and (text.isupper() or line["bold"])

    for line in lines:
        big_gap = prev_bottom is not None and (line["top"] - prev_bottom) > median_height * 2.5
        if current and (is_heading(line) or big_gap):
            blocks.append(current)
            current = [line]
        else:
            current.append(line)
        prev_bottom = line["top"] + line["height"]
    if current:
        blocks.append(current)
    return blocks


def render_block(block_lines, id_compteur):
    lefts = [l["left"] for l in block_lines]
    tops = [l["top"] for l in block_lines]
    rights = [l["left"] + l["width"] for l in block_lines]
    bottoms = [l["top"] + l["height"] for l in block_lines]
    left, top = min(lefts), min(tops)
    width, height = max(rights) - left, max(bottoms) - top

    full_text = " ".join(l["text_plain"] for l in block_lines)
    block_type = classify(full_text) if classify(full_text) != "section" else classify(block_lines[0]["text_plain"])
    title = BLOCK_TITLES.get(block_type, BLOCK_TITLES["section"])
    block_id = f"{block_type}-{id_compteur}" if block_type != "section" else f"section-{id_compteur}"

    lines_html = []
    for l in block_lines:
        weight, style = l["weight"], l["style"]
        rel_left, rel_top = l["left"] - left, l["top"] - top
        lines_html.append(
            f'<span class="cv-line" data-target-width="{l["width"]}" '
            f'style="position:absolute;left:{rel_left}px;top:{rel_top}px;'
            f'font-size:{l["size"]}px;color:{l["color"]};font-family:\'{l["family"]}\',sans-serif;'
            f'font-weight:{weight};font-style:{style};white-space:pre;">{l["html"]}</span>'
        )

    block_html = f"""
    <div class="cv-block" data-block-id="{block_id}" data-block-title="{title}" style="position:absolute;left:{left}px;top:{top}px;width:{width}px;height:{height}px;">
        {''.join(lines_html)}
    </div>"""
    return block_html


def render_page(html_text, id_counter, page_image):
    dims = PAGE_DIV_RE.search(html_text)
    width, height = float(dims.group(1)), float(dims.group(2))

    css_classes = parse_css_classes(html_text)
    lines = parse_runs(html_text, css_classes)
    if not lines:
        return width, height, ""
    estimate_geometry(lines)
    lines = drop_invisible_runs(lines, page_image, width)
    if not lines:
        return width, height, ""

    columns = cluster_columns(lines, width)

    blocks_html = []
    for column in columns:
        for block_lines in group_into_blocks(column):
            id_counter[0] += 1
            blocks_html.append(render_block(block_lines, id_counter[0]))

    return width, height, "".join(blocks_html)


def pdf_to_html(pdf_bytes, first_page=None, last_page=None, zoom=None):
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        pdf_path = out_dir / "input.pdf"
        pdf_path.write_bytes(pdf_bytes)

        page_numbers = run_pdftohtml_complex(pdf_path, out_dir, first_page, last_page, zoom)
        full_page_images = render_full_page_images(pdf_path, out_dir, first_page=first_page, last_page=last_page)

        pages_html = []
        id_counter = [0]
        for page_num in page_numbers:
            html_text = (out_dir / f"page-{page_num}.html").read_text(encoding="utf-8", errors="replace")
            width, height, content = render_page(html_text, id_counter, full_page_images.get(page_num))

            png_path = out_dir / f"page{page_num:03d}.png"
            bg_style = ""
            if png_path.exists():
                data = base64.b64encode(png_path.read_bytes()).decode("ascii")
                bg_style = f"background-image:url(data:image/png;base64,{data});background-size:100% 100%;"

            pages_html.append(
                f'<div class="cv-page-canvas" style="width:{width}px;height:{height}px;{bg_style}">{content}</div>'
            )

    html_final = f"""<div class="cv-wrapper">
    {''.join(pages_html)}
</div>

<style>
.cv-wrapper {{ width: 100%; display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 20px; }}
.cv-page-canvas {{ position: relative; background: #fff; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }}
.cv-page-canvas p {{ padding: 0; }}

.cv-block {{
    box-sizing: border-box;
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 0.2s ease;
}}
.cv-block:hover {{
    border-color: #ccc;
    background-color: rgba(0, 0, 0, 0.01);
}}
.cv-block.selected {{
    border-color: {ACCENT_COLOR} !important;
    background-color: rgba(0, 0, 0, 0.04) !important;
    z-index: 10;
}}
.cv-line {{ display: inline-block; transform-origin: left top; }}
</style>

<script>
document.querySelectorAll('.cv-line').forEach(function (el) {{
    var target = parseFloat(el.dataset.targetWidth);
    if (!target) return;
    var natural = el.getBoundingClientRect().width;
    if (natural > target + 0.5) {{
        el.style.transform = 'scaleX(' + (target / natural).toFixed(4) + ')';
    }}
}});
</script>
"""
    return html_final
